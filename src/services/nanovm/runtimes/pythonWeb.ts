/**
 * Python 侧的「Web 能力」：虚拟网络里的 WSGI 运行器，以及注入到 Pyodide 里的 nanovm 包。
 *
 * NanoVM 没有真实 socket：`vm serve <端口> <命令>` 只是注册一条命令，宿主在
 * `curl http://127.0.0.1:<端口>/path` 时把这条命令当 **CGI 程序**跑一次
 * （NANOVM_HTTP_* 环境变量描述请求，stdin 是请求体，stdout 只能放 CGI 响应）。
 * 这个文件因此负责三件事：
 *
 * 1. 提供三段纯 Python 源码（`NANOVM_PYTHON_MODULES`），由 `NANOVM_BOOTSTRAP`
 *    写进 Pyodide 的 `/usr/lib/nanovm` 并挂到 sys.path 上：
 *    - `nanovm/__init__.py`：公开 `App / json / text / redirect / request / serve`；
 *    - `nanovm/routes.py`：不依赖 Flask 的路由层，`App` 同时是 WSGI 应用；
 *    - `nanovm_serve.py`：`python3 -m nanovm_serve app:app` 的入口，NANOVM_HTTP_*
 *      → WSGI environ → 调用应用 → 写 CGI 响应。
 * 2. 解析「要不要走 WSGI 运行器」（`isServeInvocation` / `parseServeInvocation`）。
 * 3. 真正把运行器塞进 Pyodide 跑一次（`runWsgiApp`），返回进程退出码。
 *
 * 这里不引入 Pyodide 的类型（它在 CDN 上，rspack 不打进包），只声明用得到的结构。
 */

/** nanovm 模块在 Pyodide 文件系统里的安装目录 */
export const NANOVM_PYTHON_ROOT = '/usr/lib/nanovm'

/** WSGI 入口的模块名：`python3 -m nanovm_serve app:app` */
export const NANOVM_SERVE_MODULE = 'nanovm_serve'

/** 一个要写进 Pyodide 文件系统的 Python 文件（path 是 Pyodide 里的绝对路径） */
export type NanovmPythonFile = { path: string; source: string }

/**
 * nanovm 包源码。写成模板字符串是为了原样保留缩进与换行；
 * 反斜杠与 `${` 已经转义，字符串内容与 Python 源文件完全一致。
 */
const INIT_SOURCE = `"""NanoVM 的 Python 便捷 API：在虚拟网络里跑 WSGI 应用。

    from nanovm import App, json, text, request

这些名字都在 nanovm.routes 里实现，App 既是路由表也是 WSGI 应用。
"""

from nanovm.routes import (
    App,
    Request,
    Response,
    json,
    redirect,
    request,
    serve,
    text,
)

__all__ = [
    'App',
    'Request',
    'Response',
    'json',
    'redirect',
    'request',
    'serve',
    'text',
]

__version__ = '0.1.0'
`

const ROUTES_SOURCE = `"""NanoVM 虚拟网络的最小 WSGI 路由层（纯标准库，不依赖 Flask）。

用法：

    from nanovm import App, json, text, request

    app = App()

    @app.get('/hello')
    def hello():
        return json({'hello': 'world', 'name': request.query.get('name', '匿名')})

    @app.get('/users/<user_id>')
    def user(user_id):
        return text('user ' + user_id)

    @app.post('/echo')
    def echo():
        return json(request.json() or {})

\`python3 -m nanovm_serve app:app\` 会把 app 当成 WSGI 应用在虚拟网络里跑一次；
不依赖虚拟网络时也可以直接单测：app.handle('GET', '/hello')。
"""

import contextvars
import io
import json as _json
import os
import re
import sys
import traceback
import urllib.parse

__all__ = [
    'App',
    'Request',
    'Response',
    'build_environ',
    'json',
    'redirect',
    'request',
    'run_cgi',
    'serve',
    'text',
]

_DEFAULT_CONTENT_TYPE = 'text/html; charset=utf-8'

# 只收录常用状态码，够用且不必依赖 http.HTTPStatus
_REASONS = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    206: 'Partial Content',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    418: "I'm a Teapot",
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
}

# CGI 环境下没被宿主调起来时的中文提示
NANOVM_HINT = (
    'nanovm: 没有找到 NANOVM_HTTP 环境变量，这不是 NanoVM 虚拟网络的 CGI 调用。\\n'
    '请在虚拟机里这样启动：vm serve 3000 "python3 -m nanovm_serve app:app"\\n'
    '启动之后用 curl http://127.0.0.1:3000/hello 访问，宿主会带着 CGI 环境变量运行这个入口。\\n'
)

# 路径参数：/users/<user_id>
_PARAM_RE = re.compile(r'<([A-Za-z_][A-Za-z0-9_]*)>')

# 当前请求（CGI 下每次调用只有一个请求，用 ContextVar 兼容将来可能的并发）
_current_request = contextvars.ContextVar('nanovm_request', default=None)


def status_text(status):
    """状态码对应的原因短语，未知状态码按 RFC 的兜底。"""
    return _REASONS.get(int(status), 'Unknown')


def _header_pairs(headers):
    if not headers:
        return []
    if isinstance(headers, dict):
        return [(str(key), str(value)) for key, value in headers.items()]
    return [(str(key), str(value)) for key, value in headers]


class Response:
    """最小 HTTP 响应：状态码 + 头 + 正文（正文统一按 bytes 存）。"""

    __slots__ = ('status', 'headers', 'body')

    def __init__(self, body=b'', status=200, headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.body = bytes(body or b'')
        self.status = int(status)
        self.headers = _header_pairs(headers)
        if self.header('content-type') is None:
            self.headers.append(('Content-Type', _DEFAULT_CONTENT_TYPE))

    def status_line(self):
        return '%d %s' % (self.status, status_text(self.status))

    def header(self, name, default=None):
        wanted = str(name).lower()
        for key, value in self.headers:
            if key.lower() == wanted:
                return value
        return default


def json(payload, status=200, headers=None):
    """返回 JSON 响应（中文不转义，方便调试）。"""
    body = _json.dumps(payload, ensure_ascii=False, default=str).encode('utf-8')
    pairs = [('Content-Type', 'application/json; charset=utf-8')]
    pairs.extend(_header_pairs(headers))
    return Response(body, status, pairs)


def text(body='', status=200, headers=None):
    """返回纯文本响应。"""
    pairs = [('Content-Type', 'text/plain; charset=utf-8')]
    pairs.extend(_header_pairs(headers))
    return Response(body, status, pairs)


def redirect(location, status=302, headers=None):
    """返回重定向响应。"""
    pairs = [('Location', str(location))]
    pairs.extend(_header_pairs(headers))
    return Response(b'', status, pairs)


def _parse_query(raw):
    query = {}
    if not raw:
        return query
    for pair in raw.split('&'):
        if not pair:
            continue
        key, _, value = pair.partition('=')
        query[urllib.parse.unquote_plus(key)] = urllib.parse.unquote_plus(value)
    return query


class Request:
    """解析好的请求对象：method / path / query / headers / body / json()。"""

    __slots__ = ('method', 'path', 'query', 'headers', 'params', 'body', 'raw_query')

    def __init__(
        self,
        method='GET',
        path='/',
        query=None,
        headers=None,
        body=b'',
        params=None,
        raw_query='',
    ):
        self.method = (method or 'GET').upper()
        self.path = path or '/'
        self.query = dict(query or {})
        self.headers = dict(headers or {})
        self.params = dict(params or {})
        self.raw_query = raw_query or ''
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.body = body or b''

    @property
    def args(self):
        """query 的别名，跟 Flask 的 request.args 对齐。"""
        return self.query

    @property
    def text(self):
        return self.body.decode('utf-8', 'replace')

    def header(self, name, default=None):
        wanted = str(name).lower()
        for key, value in self.headers.items():
            if key.lower() == wanted:
                return value
        return default

    def get(self, name, default=None):
        return self.query.get(name, default)

    def json(self, default=None):
        if not self.body:
            return default
        try:
            return _json.loads(self.body.decode('utf-8'))
        except ValueError:
            return default

    def get_json(self, default=None):
        return self.json(default)

    def form(self):
        if not self.body:
            return {}
        return _parse_query(self.text)

    def __repr__(self):
        return '<Request %s %s>' % (self.method, self.path)


class _RequestProxy:
    """\`from nanovm import request\`：转发到当前请求，没有请求时 bool() 为假。"""

    __slots__ = ()

    def _current(self):
        current = _current_request.get()
        if current is None:
            raise RuntimeError(
                'nanovm.request 只能在请求处理函数里使用；普通脚本里请自己构造 nanovm.Request'
            )
        return current

    def __getattr__(self, name):
        return getattr(self._current(), name)

    def __bool__(self):
        return _current_request.get() is not None

    def __repr__(self):
        current = _current_request.get()
        return '<nanovm.request %s>' % ('空闲' if current is None else current)


request = _RequestProxy()


def _compile_path(path):
    """把 \`/users/<user_id>\` 编译成正则 + 参数名列表。"""
    if not path.startswith('/'):
        path = '/' + path
    parts = _PARAM_RE.split(path)
    names = []
    pattern = '^'
    for index, part in enumerate(parts):
        if index % 2 == 0:
            pattern += re.escape(part)
            continue
        if part in names:
            raise ValueError('nanovm: 路由 %r 里重复出现了路径参数 <%s>' % (path, part))
        names.append(part)
        pattern += '(?P<%s>[^/]+)' % part
    return re.compile(pattern + '$'), names


def _coerce(result):
    """处理函数的返回值统一转成 Response。"""
    if isinstance(result, Response):
        return result
    if result is None:
        return Response(b'', 204)
    if isinstance(result, tuple):
        body = result[0] if len(result) > 0 else b''
        status = result[1] if len(result) > 1 else 200
        headers = result[2] if len(result) > 2 else None
        response = _coerce(body)
        response.status = int(status)
        response.headers.extend(_header_pairs(headers))
        return response
    if isinstance(result, (dict, list)):
        return json(result)
    if isinstance(result, bytes):
        return Response(result, 200, [('Content-Type', 'application/octet-stream')])
    return text(str(result))


class App:
    """路由表 + WSGI 应用。

    - \`@app.get('/path')\` / \`post\` / \`put\` / \`delete\` 注册路由；
    - 路径参数 \`/users/<user_id>\` 会以同名关键字参数传进处理函数；
    - \`app.handle(method, path, headers, body)\` 返回 Response，方便单元测试；
    - \`app(environ, start_response)\` 让它本身就是一个 WSGI 应用。
    """

    def __init__(self, name=None):
        self.name = name or 'nanovm'
        self.routes = []
        self.error_handler = None

    # ---------- 路由注册 ----------

    def route(self, path, methods=('GET',), endpoint=None):
        def decorator(handler):
            self.add_route(path, handler, methods, endpoint)
            return handler

        return decorator

    def add_route(self, path, handler, methods=('GET',), endpoint=None):
        if isinstance(methods, str):
            methods = [methods]
        regex, names = _compile_path(path)
        label = endpoint or getattr(handler, '__name__', 'handler')
        for method in methods:
            self.routes.append((str(method).upper(), regex, names, handler, label, path))
        return handler

    def get(self, path, endpoint=None):
        return self.route(path, ('GET', 'HEAD'), endpoint)

    def post(self, path, endpoint=None):
        return self.route(path, ('POST',), endpoint)

    def put(self, path, endpoint=None):
        return self.route(path, ('PUT',), endpoint)

    def patch(self, path, endpoint=None):
        return self.route(path, ('PATCH',), endpoint)

    def delete(self, path, endpoint=None):
        return self.route(path, ('DELETE',), endpoint)

    def error(self, handler):
        """注册异常处理器：handler() 返回任意可转成 Response 的值。"""
        self.error_handler = handler
        return handler

    # ---------- 分发 ----------

    def handle(self, method, path, headers=None, body=b'', query=None, raw_query=None):
        """处理一次请求并返回 Response（单元测试直接用它）。"""
        method = (method or 'GET').upper()
        raw_path = path or '/'
        if '?' in raw_path:
            raw_path, _, inline = raw_path.partition('?')
            if raw_query is None:
                raw_query = inline
        if raw_query is None:
            raw_query = ''
        if query is None:
            query = _parse_query(raw_query)
        if not raw_path.startswith('/'):
            raw_path = '/' + raw_path

        handler = None
        params = {}
        allowed = set()
        for route_method, regex, _names, target, _label, _rule in self.routes:
            match = regex.match(raw_path)
            if match is None:
                continue
            allowed.add(route_method)
            if route_method == method and handler is None:
                handler = target
                params = match.groupdict()

        if handler is None:
            return self._default_response(method, raw_path, allowed)

        current = Request(
            method=method,
            path=raw_path,
            query=query,
            headers=headers,
            body=body,
            params=params,
            raw_query=raw_query,
        )
        token = _current_request.set(current)
        try:
            return _coerce(handler(**params))
        except Exception:
            traceback.print_exc()
            return self._error_response()
        finally:
            _current_request.reset(token)

    def _default_response(self, method, path, allowed):
        if allowed:
            headers = [('Allow', ', '.join(sorted(allowed)))]
            return Response('405 Method Not Allowed: %s %s\\n' % (method, path), 405, headers)
        return Response('404 Not Found: %s\\n' % path, 404)

    def _error_response(self):
        if self.error_handler is not None:
            try:
                return _coerce(self.error_handler())
            except Exception:
                traceback.print_exc()
        return Response(
            '500 Internal Server Error\\n',
            500,
            [('Content-Type', 'text/plain; charset=utf-8')],
        )

    # ---------- WSGI ----------

    def __call__(self, environ, start_response):
        method = environ.get('REQUEST_METHOD') or 'GET'
        path = environ.get('PATH_INFO') or '/'
        headers = {}
        for key, value in environ.items():
            if key.startswith('HTTP_'):
                headers[key[5:].replace('_', '-').lower()] = value
        for name in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
            if environ.get(name):
                headers[name.lower().replace('_', '-')] = environ[name]
        stream = environ.get('wsgi.input')
        body = stream.read() if stream is not None else b''
        response = self.handle(
            method,
            path,
            headers=headers,
            body=body,
            raw_query=environ.get('QUERY_STRING') or '',
        )
        start_response(response.status_line(), list(response.headers))
        return [response.body]


def build_environ(body=b'', env=None):
    """把 NANOVM_HTTP_* 环境变量翻译成 WSGI environ。"""
    source = os.environ if env is None else env
    method = (source.get('NANOVM_HTTP_METHOD') or 'GET').upper()
    url = source.get('NANOVM_HTTP_URL') or '/'
    parsed = urllib.parse.urlsplit(url)
    path = urllib.parse.unquote(parsed.path or '/')
    if isinstance(body, str):
        body = body.encode('utf-8')
    body = body or b''

    headers = {}
    raw_headers = source.get('NANOVM_HTTP_HEADERS') or ''
    if raw_headers:
        try:
            decoded = _json.loads(raw_headers)
        except ValueError:
            decoded = None
        if isinstance(decoded, dict):
            for key, value in decoded.items():
                headers[str(key)] = '' if value is None else str(value)

    environ = {
        'REQUEST_METHOD': method,
        'SCRIPT_NAME': '',
        'PATH_INFO': path,
        'QUERY_STRING': parsed.query or '',
        'REQUEST_URI': url,
        'RAW_URI': url,
        'SERVER_NAME': source.get('NANOVM_HTTP_HOST') or '127.0.0.1',
        'SERVER_PORT': source.get('NANOVM_HTTP_PORT') or '80',
        'SERVER_PROTOCOL': 'HTTP/1.1',
        'SERVER_SOFTWARE': 'NanoVM',
        'REMOTE_ADDR': '127.0.0.1',
        'wsgi.version': (1, 0),
        'wsgi.url_scheme': 'http',
        'wsgi.input': io.BytesIO(body),
        'wsgi.errors': sys.stderr,
        'wsgi.multithread': False,
        'wsgi.multiprocess': False,
        'wsgi.run_once': True,
        'CONTENT_TYPE': '',
        'CONTENT_LENGTH': '',
    }
    for key, value in headers.items():
        name = key.upper().replace('-', '_')
        if name in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
            environ[name] = value
            continue
        environ['HTTP_' + name] = value
    if body:
        # 请求体就在手上，长度以实际字节数为准
        environ['CONTENT_LENGTH'] = str(len(body))
    return environ


def _read_stdin(stdin):
    if stdin is None:
        stream = getattr(sys.stdin, 'buffer', sys.stdin)
        try:
            return stream.read()
        except Exception:
            return b''
    if hasattr(stdin, 'read'):
        return stdin.read()
    return stdin


# CGI 响应里不写 Content-Length（宿主按实际字节数补），也不写传输层的头
_SKIP_HEADERS = frozenset(('content-length', 'transfer-encoding'))


def _cgi_head(status, headers):
    lines = ['Status: %s' % status]
    for key, value in headers:
        if str(key).lower() in _SKIP_HEADERS:
            continue
        lines.append('%s: %s' % (key, value))
    return ('\\r\\n'.join(lines) + '\\r\\n\\r\\n').encode('utf-8', 'replace')


def _write_cgi(head, payload):
    stream = getattr(sys.stdout, 'buffer', None)
    if stream is None:
        sys.stderr.write('nanovm: stdout 不支持二进制写入，CGI 响应发不出去\\n')
        return
    stream.write(head)
    if payload:
        stream.write(payload)
    stream.flush()
    # Pyodide 的行缓冲 stdout 只有遇到换行才把最后一行交出来：补一个哨兵换行。
    # runPython 按行重拼输出时它会重新变成分隔符，不会给响应正文多出一个字节。
    try:
        sys.stdout.write('\\n')
        sys.stdout.flush()
    except (AttributeError, ValueError):
        pass


def run_cgi(target, environ=None, stdin=None):
    """跑一次 WSGI 调用，把 CGI 响应写到 stdout（普通 print 改走 stderr）。

    返回退出码：0 表示响应已经写出去（即使应用自己抛了异常，也会写 Status: 500）。
    """
    body = _read_stdin(stdin)
    if isinstance(body, str):
        body = body.encode('utf-8')
    body = body or b''
    if environ is None:
        environ = build_environ(body)
    else:
        environ = dict(environ)
        if 'wsgi.input' not in environ:
            environ['wsgi.input'] = io.BytesIO(body)

    captured = {'status': None, 'headers': []}
    written = []

    def start_response(status, headers, exc_info=None):
        if exc_info is not None:
            try:
                if captured['status'] is not None:
                    raise exc_info[1].with_traceback(exc_info[2])
            finally:
                exc_info = None
        captured['status'] = status
        captured['headers'] = list(headers)
        # WSGI 允许应用用 write() 直接吐数据，这里一并收下
        return written.append

    saved_stdout = sys.stdout
    chunks = []
    failure = False
    try:
        # CGI 模式下 stdout 只能放响应，应用里的普通 print 一律改走 stderr
        sys.stdout = sys.stderr
        chunks = list(target(environ, start_response))
    except BaseException:
        failure = True
        traceback.print_exc()
    finally:
        sys.stdout = saved_stdout

    if failure or captured['status'] is None:
        head = _cgi_head('500 Internal Server Error', [('Content-Type', 'text/plain; charset=utf-8')])
        _write_cgi(head, b'500 Internal Server Error\\n')
        return 0

    pieces = written + chunks
    payload = b''.join(
        piece if isinstance(piece, bytes) else str(piece).encode('utf-8') for piece in pieces
    )
    if (environ.get('REQUEST_METHOD') or '').upper() == 'HEAD':
        payload = b''
    _write_cgi(_cgi_head(captured['status'], captured['headers']), payload)
    return 0


def serve(app=None):
    """在 CGI 环境里直接跑 \`app\`；没有 NANOVM_HTTP 时给出中文提示并退出。"""
    if not os.environ.get('NANOVM_HTTP'):
        sys.stderr.write(NANOVM_HINT)
        raise SystemExit(1)
    target = app if app is not None else _main_app()
    return run_cgi(target)


def _main_app():
    module = sys.modules.get('__main__')
    for name in ('app', 'application', 'wsgi_app'):
        target = getattr(module, name, None) if module is not None else None
        if target is not None:
            return target
    raise SystemExit('nanovm: serve() 找不到 app 对象，请显式传入 serve(app)')
`

const SERVE_SOURCE = `"""\`python3 -m nanovm_serve app:app\`：在 NanoVM 虚拟网络里跑 WSGI 应用。

宿主用 \`vm serve <端口> "python3 -m nanovm_serve app:app"\` 注册服务，之后每次
curl 都会带着 NANOVM_HTTP_* 环境变量把这条命令当 CGI 程序跑一次：

- 环境变量描述请求（方法 / URL / Host / 头），请求体走 stdin；
- 响应写 stdout，只能是 CGI 头 + 正文（普通 print 已经改走 stderr）；
- 应用抛异常时回 Status: 500，异常栈打到 stderr，退出码仍然是 0。
"""

import importlib
import os
import sys


def _load_target(spec):
    """按 \`module:attr\` 加载应用；只写模块名时默认取 app 属性。"""
    module_name, _, attr = spec.partition(':')
    attr = attr or 'app'
    if not module_name:
        raise SystemExit('nanovm_serve: 应用路径不合法：%r，应该写成 app:app' % spec)
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    try:
        module = importlib.import_module(module_name)
    except ImportError as error:
        raise SystemExit(
            'nanovm_serve: 找不到模块 %r（%s）。请在 app.py 所在目录启动。' % (module_name, error)
        )
    target = getattr(module, attr, None)
    if target is None:
        raise SystemExit('nanovm_serve: 模块 %r 里没有 %r 对象' % (module_name, attr))
    return target


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if not os.environ.get('NANOVM_HTTP'):
        from nanovm.routes import NANOVM_HINT

        sys.stderr.write(NANOVM_HINT)
        return 1
    if not args or args[0] in ('-h', '--help'):
        sys.stderr.write('用法：python3 -m nanovm_serve <模块:属性>\\n')
        return 1 if not args else 0
    target = _load_target(args[0])
    if not callable(target):
        sys.stderr.write(
            'nanovm_serve: %r 不是 WSGI 应用（应该是 nanovm.App 实例或 Flask 应用）\\n' % args[0]
        )
        return 1
    from nanovm.routes import run_cgi

    return run_cgi(target)


if __name__ == '__main__':
    sys.exit(main())
`

/** 注入清单：runPython 第一次用到 Pyodide 时按这个顺序写文件 */
export const NANOVM_PYTHON_MODULES: NanovmPythonFile[] = [
  { path: `${NANOVM_PYTHON_ROOT}/nanovm/__init__.py`, source: INIT_SOURCE },
  { path: `${NANOVM_PYTHON_ROOT}/nanovm/routes.py`, source: ROUTES_SOURCE },
  { path: `${NANOVM_PYTHON_ROOT}/nanovm_serve.py`, source: SERVE_SOURCE },
]

/** 拼进 Python 源码的字符串字面量：JSON 的转义规则在 Python 里同样合法 */
const pythonLiteral = (value: unknown): string => JSON.stringify(value)

/** 生成「写文件 + 挂 sys.path」的引导代码，模块源码嵌在里面，不需要额外的下载 */
const buildBootstrap = (): string => {
  const files = NANOVM_PYTHON_MODULES.map(
    (file) => `    (${pythonLiteral(file.path)}, ${pythonLiteral(file.source)}),`
  ).join('\n')
  return [
    '# 由 runtimes/pythonWeb.ts 生成：把 nanovm 模块写进 Pyodide 文件系统并挂到 sys.path 上。',
    'import os',
    'import sys',
    '',
    `_NANOVM_ROOT = ${pythonLiteral(NANOVM_PYTHON_ROOT)}`,
    `_NANOVM_FALLBACK = '/tmp/nanovm'`,
    '_NANOVM_FILES = [',
    files,
    ']',
    '',
    '',
    'def _nanovm_install(root):',
    '    for path, source in _NANOVM_FILES:',
    '        target = path if root == _NANOVM_ROOT else root + path[len(_NANOVM_ROOT):]',
    '        parent = os.path.dirname(target)',
    '        if parent and not os.path.isdir(parent):',
    '            os.makedirs(parent, exist_ok=True)',
    `        with open(target, 'w', encoding='utf-8') as handle:`,
    '            handle.write(source)',
    '',
    '',
    '_nanovm_root = _NANOVM_ROOT',
    'try:',
    '    _nanovm_install(_nanovm_root)',
    'except OSError:',
    '    # 文件系统只读（很少见）时退到 /tmp，功能一样，只是路径变了',
    '    _nanovm_root = _NANOVM_FALLBACK',
    '    _nanovm_install(_nanovm_root)',
    'if _nanovm_root not in sys.path:',
    '    sys.path.insert(0, _nanovm_root)',
  ].join('\n')
}

/**
 * 装好 nanovm 模块并 append sys.path 的 Python 引导代码。
 * runPython 在每个 Pyodide 实例上只执行一次（模块级标记）。
 */
export const NANOVM_BOOTSTRAP = buildBootstrap()

/** 一次 `-m nanovm_serve` 调用：应用路径（module:attr）+ 传给 sys.argv 的其余参数 */
export type ServeInvocation = { app: string; argv: string[] }

/** 解释器里可以忽略的短选项（放在 -m 前面也不影响语义） */
const IGNORED_FLAGS = ['-u', '-B', '-O', '-OO', '-s', '-E', '-q', '-i', '-b', '-d']

/**
 * 解析 `python3 -m nanovm_serve app:app`。
 * 不是这种调用时返回 null；`-m nanovm_serve` 后面没给应用路径时 app 为空串，
 * 交给 `nanovm_serve` 自己打印用法。
 */
export const parseServeInvocation = (argv: string[]): ServeInvocation | null => {
  const args = [...argv]
  while (args.length > 0 && IGNORED_FLAGS.includes(args[0])) {
    args.shift()
  }
  if (args[0] !== '-m' || args[1] !== NANOVM_SERVE_MODULE) {
    return null
  }
  const rest = args.slice(2)
  return { app: rest.find((arg) => !arg.startsWith('-')) ?? '', argv: rest }
}

/** 是否是 WSGI 运行请求：`python3 -m nanovm_serve app:app` */
export const isServeInvocation = (argv: string[]): boolean => parseServeInvocation(argv) !== null

/** 运行器需要的上下文：cwd 要进 sys.path / chdir，应用里的相对路径和 import 才找得到 */
export type ServeRunnerOptions = { cwd?: string }

/**
 * 生成 WSGI 运行器的 Python 源码：设置 sys.argv / PYTHONPATH 后
 * `runpy.run_module('nanovm_serve', run_name='__main__')`，并把退出码写进
 * `__nanovm_exit_code`（跟 buildPythonRunner 的约定一致）。
 */
export const buildServeRunner = (
  invocation: ServeInvocation,
  options: ServeRunnerOptions = {}
): string => {
  const modulePath = `${NANOVM_PYTHON_ROOT}/${NANOVM_SERVE_MODULE}.py`
  const root = pythonLiteral(NANOVM_PYTHON_ROOT)
  const chdir = options.cwd
    ? [`try:`, `    os.chdir(${pythonLiteral(options.cwd)})`, `except OSError:`, `    pass`]
    : []
  return [
    '__nanovm_exit_code = 0',
    'import os',
    'import sys',
    `sys.argv = ${pythonLiteral([modulePath, ...invocation.argv])}`,
    `sys.path.insert(0, ${root})`,
    ...(options.cwd ? [`sys.path.insert(0, ${pythonLiteral(options.cwd)})`] : []),
    ...chdir,
    `_nanovm_path = os.environ.get('PYTHONPATH') or ''`,
    `if ${root} not in _nanovm_path.split(':'):`,
    `    os.environ['PYTHONPATH'] = ${root} + ((':' + _nanovm_path) if _nanovm_path else '')`,
    'try:',
    '    import runpy',
    `    runpy.run_module('${NANOVM_SERVE_MODULE}', run_name='__main__')`,
    'except SystemExit as __nanovm_signal:',
    '    __nanovm_status = __nanovm_signal.code',
    '    if __nanovm_status is None:',
    '        __nanovm_exit_code = 0',
    '    elif isinstance(__nanovm_status, int):',
    '        __nanovm_exit_code = __nanovm_status',
    '    else:',
    `        sys.stderr.write(str(__nanovm_status) + '\\n')`,
    '        __nanovm_exit_code = 1',
    'except BaseException:',
    '    import traceback',
    '    traceback.print_exc()',
    '    __nanovm_exit_code = 1',
  ].join('\n')
}

/** 跑运行器需要的 Pyodide 子集（stdout / stderr 已经由 runPython 接到 io 上） */
export type PyodideSandbox = {
  runPython: (code: string) => unknown
  globals: { get: (name: string) => unknown }
}

/**
 * 在装好 nanovm 模块的 Pyodide 实例里跑一次 WSGI 请求，返回进程退出码。
 * 输出（CGI 响应）直接写 Pyodide 的 stdout，也就是调用方接好的 io.stdout。
 */
export const runWsgiApp = (
  pyodide: PyodideSandbox,
  invocation: ServeInvocation,
  options: ServeRunnerOptions = {}
): number => {
  pyodide.runPython(buildServeRunner(invocation, options))
  const value = pyodide.globals.get('__nanovm_exit_code')
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
