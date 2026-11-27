/**
 * 主界面「文档」：按语言提供 wiki 式说明。
 *
 * 文本里支持两种行内链接：
 * - `[标题](#section-id)`：跳到本文档的某个小节（蓝色链接）；
 * - `[标题](https://…)`：外部链接，新窗口打开。
 */

export type DocsBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'note'; text: string }
  | { type: 'code'; text: string }
  | { type: 'h3'; text: string }

export type DocsSection = { id: string; title: string; blocks: DocsBlock[] }

export type DocsDoc = {
  title: string
  subtitle: string
  intro: string
  sections: DocsSection[]
}

const zh: DocsDoc = {
  title: '项目文档',
  subtitle: '专有名词、开关用途与使用说明',
  intro:
    '这是一个基于 DeepSeek 接口的非官方聊天前端：把提示词编排、工具调用、本地虚拟机与记忆检索都放在浏览器里完成。[仓库](https://github.com/xiaohuangbo/chat-demo-unrestricted)、[在线演示](https://chat-unrestricted.fur0.com/)、[上游 chat-demo](https://github.com/deepseek-ai/chat-demo)。左侧目录可以直接跳到对应小节。',
  sections: [
    {
      id: 'overview',
      title: '这个项目是什么',
      blocks: [
        {
          type: 'p',
          text: '应用本身是静态网页（安卓端是 WebView 壳），没有自建后端：对话、附件、记忆都存在浏览器本地，只有请求模型与文件上传会发到 DeepSeek。它把这些能力组合在一起：[Harness](#glossary) 式的提示词编排、越狱开关（见 [破甲](#jailbreak)）、联网搜索、长文本附件、网状记忆，以及三个跑在浏览器里的虚拟机（见 [虚拟机](#vms)）。',
        },
        {
          type: 'ul',
          items: [
            '桌面浏览器打开网页即可用；安卓端安装 APK，数据存在应用自己的 WebView 里。',
            'API Key 只保存在本机，不上传、不写进导出文件。',
            '设置页的每个开关都会立即写入 localStorage，刷新后保留。',
          ],
        },
        {
          type: 'note',
          text: '所有「破甲」功能修改的是请求与提示词，不会改变模型权重，也不能保证每次都成功；服务端策略调整时需要跟着更新。',
        },
      ],
    },
    {
      id: 'settings-map',
      title: '设置页总览',
      blocks: [
        {
          type: 'p',
          text: '设置弹窗共 18 组。第一次用可以只关心「数据管理」（填 API Key）与「模型」；其余按需打开。',
        },
        {
          type: 'table',
          head: ['分组', '内容'],
          rows: [
            ['通用设置', '主题、界面语言、朗读音色、位置、回复展示（思考内容自动折叠）、每日用量与提醒'],
            ['模型', '当前模型、流式输出、温度、Top P、最大输出、自动压缩、关键词拒答'],
            ['角色', '角色卡：昵称、性别、人设、头像、自动记忆；会话在输入栏选角色'],
            ['本地模型', 'WebGPU 探测、WebLLM 模型目录、MLC-LLM API、模型包导入、缓存与上下文窗口'],
            [
              '破甲',
              '解除限制、提示词预设、自动越狱、注入、伪装、防撤回、跳过审核、扰动、调参、整形',
            ],
            ['思维链', '自定义思考步骤、示例、注入预览；关闭深度思考时也会提示'],
            ['搜索投毒', '时间与知识截止、接管搜索、关键字 / 正则替换、黑名单、强制结果、白名单'],
            ['记忆', '长期记忆、自动提炼、记忆更新提示、网状记忆库、导入导出、关系图、搜索调试'],
            ['附件', '附件限制、大小与数量、扩展名白名单、大文本附件、附件投毒'],
            ['浏览器工具', '一个主开关 + 十二项能力开关（含 GenUI 与自定义提示词注入工具）、通知权限、风险标签'],
            ['工作区', '浏览器本地文件库：新建 / 编辑 / 删除、导入导出'],
            ['虚拟机', 'NanoVM Slim / WebVM 的开关、工具链、网络、内存与配额'],
            ['Unkernel Linux', '发行版、数据盘、CPU、联网、声音、显示、Worker、Wisp、超时；内存交给虚拟机自己的设置'],
            ['统计', '用量概览、趋势、热力图、输入构成、按模型拆分、上下文管理'],
            ['账户与用量', '账户余额、今日 / 近 30 天 token 与费用、语音与搜索附加用量'],
            ['数据管理', 'API Key、导入、导出、恢复默认（联动所有 store）、删除全部对话'],
            ['关于', '仓库与演示地址、检查更新'],
            ['更新日志', '版本记录与上游鸣谢'],
          ],
        },
        {
          type: 'note',
          text: '设置改动立即生效并写入本机；换浏览器或清除站点数据后需要重新配置。导出聊天归档不会带上设置。',
        },
      ],
    },
    {
      id: 'roles',
      title: '角色与我的资料',
      blocks: [
        {
          type: 'p',
          text: '角色是一套可复用的「人设 + 头像 + 自动记忆」配置。在设置 → 角色里新建，回到输入栏用角色选择器切换；人设会注入 system，和破甲提示词按顺序拼接。',
        },
        {
          type: 'ul',
          items: [
            '昵称、性别、人设提示词、头像（圆形取景框裁剪，输出 384×384）都在角色卡里编辑。',
            '「我的资料」里的称呼会作为「用户称呼」写进 system，让模型知道怎么叫你。',
            '开启自动记忆后，角色会在对话中自行记录重要事实到长期记忆。',
            '角色只影响新请求的 system，不会改写历史消息。',
          ],
        },
      ],
    },
    {
      id: 'workspace',
      title: '工作区与文件',
      blocks: [
        {
          type: 'p',
          text: '工作区是浏览器本地的一个虚拟文件库（OPFS / IndexedDB），模型与虚拟机都能读写；它和「附件」不是一回事：附件是随消息上传给模型的文件，工作区是持久目录。',
        },
        {
          type: 'ul',
          items: [
            '可以新建、编辑、重命名、删除文件，单文件下载，或整包导入（合并 / 覆盖）与导出 zip。',
            '网页 Agent 模式会下发 `list_workspace` / `read_workspace_file` / `write_workspace_file` / `diff_workspace_file` / `delete_workspace_file` 五个工具。',
            'Unkernel 会把工作区挂到 guest 的 `/mnt/workspace`，NanoVM / WebVM 也能通过工具互传文件。',
            '删除会话不会删除工作区文件；工作区需要单独清理。',
          ],
        },
      ],
    },
    {
      id: 'speech',
      title: '语音、朗读与输入',
      blocks: [
        {
          type: 'p',
          text: '回复可以用服务端 TTS 朗读（设置 → 通用里的音色），也可以点消息上的朗读按钮。语音输入使用浏览器 / 系统的语音识别，识别结果直接进输入框。',
        },
        {
          type: 'ul',
          items: [
            '朗读会以请求形式计费，出现在账户用量的「语音」一栏。',
            '停止朗读在切换会话、发送新消息或点击停止时自动执行。',
            '语音识别是否可用取决于浏览器与系统输入法，安卓 WebView 上可能被系统限制。',
          ],
        },
      ],
    },
    {
      id: 'sessions',
      title: '会话、分支与消息操作',
      blocks: [
        {
          type: 'p',
          text: '每个会话是一棵消息树：重新生成会留下多个版本，聊天区左右箭头切换版本；「分支到新对话」把当前分支复制成新会话，原会话不受影响。',
        },
        {
          type: 'ul',
          items: [
            '消息右键或悬浮按钮提供复制、编辑、重试、评分；编辑后的内容会用于后续轮次。',
            '会话可以重命名、置顶、删除；删除会话会一并清理只有它引用的本地附件。',
            '长会话可以手动或自动压缩（见 [统计与计费](#stats)），压缩摘要会替代被压缩的历史。',
          ],
        },
      ],
    },
    {
      id: 'modes',
      title: '聊天模式',
      blocks: [
        {
          type: 'p',
          text: '输入栏的「模式」决定这一轮模型能看到哪些工具，同时写进 system，让模型知道自己能做什么。切换只影响之后的请求，不改变历史内容。',
        },
        {
          type: 'table',
          head: ['模式', '可用能力', '典型用途'],
          rows: [
            ['仅聊天', '不下发浏览器、工作区、虚拟机工具；长期记忆照常注入', '纯对话、写作、分析'],
            [
              '网页 Agent',
              '浏览器工具 + 虚拟工作区（读写文件、抓网页、通知等）',
              '查资料、整理工作区',
            ],
            [
              'PTC',
              '在网页 Agent 之上加 NanoVM / WebVM，可批量、并发调用虚拟机',
              '一次跑多条命令、批量处理文件',
            ],
            [
              '创造',
              '在 PTC 之上允许模型在虚拟机里装运行时、写新命令；虚拟机写操作免逐次确认',
              '让模型自己搭环境、写工具',
            ],
          ],
        },
        {
          type: 'note',
          text: '使用本地模型时只允许「仅聊天」，其余模式会置灰；这是因为本地模型没有服务端工具与 Files API。',
        },
      ],
    },
    {
      id: 'input',
      title: '输入栏与深度思考',
      blocks: [
        {
          type: 'p',
          text: '输入栏第二排是这一轮的临时开关：深度思考、智能搜索、自动越狱、扰动、聊天模式与模型。它们只影响下一次请求。',
        },
        {
          type: 'ul',
          items: [
            '深度思考 0–4 档：按档位下发 budget_tokens 与 reasoning_effort；服务端不认识时自动去掉强度重试。',
            '智能搜索：给模型声明 deepseek_web_search / deepseek_read_url 工具，让它自己决定何时搜索。',
            '自动越狱：本轮被拒绝时换下一套提示词组合自动重试（见 [破甲](#jailbreak)）。',
            '扰动：发送前改写命中的敏感词；不改变你看到的历史，只改变下发的文本。',
            '上下文圆环：显示当前会话占用、压缩阈值与服务端缓存命中情况。',
          ],
        },
      ],
    },
    {
      id: 'models',
      title: '模型与采样参数',
      blocks: [
        {
          type: 'p',
          text: '内置两个云端模型，另有本地模型（见 [本地模型](#local-models)）。模型决定能力边界，采样参数只影响输出风格。',
        },
        {
          type: 'table',
          head: ['模型', '特点', '限制'],
          rows: [
            [
              'deepseek-flash（V4.1 Flash）',
              '上下文 1M，支持图片输入、深度思考、服务端搜索与阅读链接',
              '高并发场景费用低，复杂推理不如 Pro',
            ],
            [
              'deepseek-v4-pro（V4 Pro）',
              '上下文 1M，长链推理更强',
              '不接受服务端联网工具与 latest_reminder 角色，标题由客户端生成',
            ],
            ['本地模型', 'WebLLM / MLC-LLM，token 不计费', '仅聊天模式，能力与窗口取决于模型'],
          ],
        },
        {
          type: 'table',
          head: ['参数', '默认值', '说明'],
          rows: [
            ['温度 temperature', '1', '只影响采样；思考模式下服务端按 1 处理'],
            ['Top P', '1', '核采样阈值'],
            ['最大输出 max_tokens', '跟随模型', '含思考 token；留空由服务端决定'],
            ['思考深度', '关闭', '0–4 档，映射到 budget_tokens 与 reasoning_effort'],
            ['自动压缩', '关闭', '开启后窗口 80% 触发，摘要替换旧历史'],
          ],
        },
        {
          type: 'p',
          text: '采样参数可以在「模型」页设置全局默认，也可以用自动调参按每轮上下文动态选择；两者都只改变下发给服务端的参数，不会改写历史。温度、Top P 等参数的含义与推荐值见 [解码与采样参数](#decoding)。',
        },
      ],
    },
    {
      id: 'decoding',
      title: '解码与采样参数（温度、Top P 等）',
      blocks: [
        {
          type: 'p',
          text: '模型每一步都在给词表里的每个 token 打分，再按概率挑一个。采样参数就是控制「怎么从这些概率里挑」——它们不改变模型的知识，只改变输出的随机性与多样性。本页按参数逐个解释，最后给几组可直接照抄的组合。',
        },
        { type: 'h3', text: '温度 temperature：控制随机程度' },
        {
          type: 'p',
          text: '温度 T 会先把分数除以 T 再做 softmax：T < 1 让高概率的词更突出（更确定、更保守），T > 1 让分布更平坦（更随机、更发散）。T = 0 等价于每次取概率最高的词（贪心解码），但服务端实现仍可能带一点随机性，不保证逐字复现。',
        },
        {
          type: 'ul',
          items: [
            '范围 0–2，步进 0.05，默认 1。',
            '思考模式下服务端通常固定按 1 处理温度，它主要影响最终正文的写法。',
            '温度不改变事实正确性本身：调低只会减少「胡说」的概率，不会让模型知道更多。',
            '同一个问题、同一温度也可能得到不同答案，这是采样的正常现象。',
          ],
        },
        {
          type: 'table',
          head: ['场景', '建议温度', '原因'],
          rows: [
            ['事实问答、代码、翻译、结构化输出', '0.2–0.5', '减少漂移与编造，格式更稳'],
            ['普通聊天、总结、解释', '0.7–1.0', '平衡准确与自然'],
            ['创意写作、起名、头脑风暴', '1.0–1.4', '更多用词与思路变化'],
            ['高于 1.5', '不建议', '容易重复、跑题、语言混杂'],
          ],
        },
        { type: 'h3', text: 'Top P（核采样）：控制候选范围' },
        {
          type: 'p',
          text: 'Top P 先按概率从高到低排序，只保留累计概率达到 P 的最小词集合（nucleus），再在这个集合里按归一化后的概率采样。P = 1 表示不裁剪；P 越小，候选越少、输出越稳。它和温度都控制随机性，但作用方式不同：温度改变分布形状，Top P 直接砍掉长尾。',
        },
        {
          type: 'ul',
          items: [
            '范围 0.01–1，默认 1。',
            '通常只调一个：要么用温度，要么用 Top P；两个同时压低会过度保守、容易复读。',
            '出现重复时，先略升温度或略降 Top P（一次只改一个），再观察 2–3 轮。',
            '代码、JSON 等严格格式任务，0.85–0.95 配合低温度通常最稳。',
          ],
        },
        { type: 'h3', text: '最大输出 max_tokens：一次能写多少' },
        {
          type: 'p',
          text: 'max_tokens 是本次回复的输出上限，包含思考 token。留空表示由服务端决定；范围 1–65536。触到上限时 stop_reason 为 max_tokens，界面会显示「达到输出上限」，长文建议分段续写而不是一次拉满。',
        },
        { type: 'h3', text: '思考深度与预算（reasoning effort / budget_tokens）' },
        {
          type: 'p',
          text: '输入栏的深度思考有 0–4 档：0 关闭，1–4 分别对应 reasoning_effort 的 low / medium / high / max，以及 budget_tokens 1024 / 4096 / 12000 / 32000。档位越高，模型在回答前思考得越久，也更慢更贵；服务端不支持这两个字段时会自动去掉强度重试一次。',
        },
        {
          type: 'p',
          text: '历史里的思考默认不回传（服务端也会丢弃）；开启「历史思维链伪装」后才会把上一轮思考并入助手正文，用于续写连贯性。',
        },
        { type: 'h3', text: '频率 / 存在 / 重复惩罚' },
        {
          type: 'p',
          text: '自动调参会计算 frequency_penalty（按出现次数惩罚）、presence_penalty（出现过就惩罚，鼓励新话题）与 repetition_penalty（直接压低重复 token）。但 Anthropic 兼容接口不接受这些参数，最终请求只下发 temperature 与 top_p，所以它们只体现在调参策略的选择上。',
        },
        { type: 'h3', text: '流式输出' },
        {
          type: 'p',
          text: '开启后用 SSE 逐字渲染，首 token 更快、能随时中断；关闭时等完整回复再显示，适合网络不稳或不想看中间状态的场景。两种方式计费相同。',
        },
        { type: 'h3', text: '参数组合速查' },
        {
          type: 'table',
          head: ['场景', '温度', 'Top P', '思考'],
          rows: [
            ['代码 / 事实 / 翻译', '0.3', '0.9', '按需'],
            ['日常对话', '0.8', '0.95', '开'],
            ['创意写作', '1.1', '1', '开'],
            ['严格 JSON / 格式', '0.2', '0.85', '关'],
            ['不确定时', '0.7', '1', '开'],
          ],
        },
        {
          type: 'note',
          text: '一次只改一个参数，观察 2–3 轮再决定；同时改温度和 Top P 很难判断是哪一个起了作用。',
        },
      ],
    },
    {
      id: 'tokens',
      title: 'Token、上下文、缓存与压缩',
      blocks: [
        { type: 'h3', text: '什么是 token' },
        {
          type: 'p',
          text: '模型按 token 计费与限长，一个 token 大约是一个词或半个词。中文通常 1 个字约 1 token，英文约 4 个字符约 1 token；数字、代码和标点会被拆得更碎，所以「字符数 ÷ 4」只是粗估。应用里的分片阈值、成本预估都用这个粗略口径，真实用量以服务端返回的 usage 为准。',
        },
        { type: 'h3', text: '上下文窗口' },
        {
          type: 'p',
          text: '当前模型上下文为 1,048,576 token（1M），包含 system、历史消息、附件解析结果与本次输出。超过会直接报错。另有一条服务端限制：请求带 DeepSeek 扩展字段时用户输入上限 32768 token，应用在输入过大时会自动去掉这些字段。',
        },
        { type: 'h3', text: '前缀缓存（cache hit）' },
        {
          type: 'p',
          text: '服务端会缓存重复的前缀（system、较长的历史），命中部分按更低价格计费：Flash 每百万 token 0.02 对 1，Pro 0.15 对 4.5（以设置页价格表为准）。保持 system 稳定、少改提示词与破甲开关，能让更多前缀命中缓存。',
        },
        { type: 'h3', text: '自动压缩' },
        {
          type: 'p',
          text: '开启后，当上下文占用达到窗口的 80%（并留出输出预留与 64k 余量）时，把较早的历史替换成结构化摘要，摘要以 latest_reminder 或折进 system 的方式下发。压缩会丢细节，重要事实建议写进长期记忆或记忆库。默认关闭。',
        },
        { type: 'h3', text: '费用估算' },
        {
          type: 'p',
          text: '按官方价格区分高峰（工作日 9:00–12:00、14:00–18:00 北京时间）与空闲时段；搜索、文档解析、语音朗读单独计价。界面里的费用是估算，实际以账单为准。',
        },
      ],
    },
    {
      id: 'refusal',
      title: '关键词拒答与安全开关',
      blocks: [
        {
          type: 'p',
          text: '「关键词拒答」是一个纯本地的前置检查：命中你配置的关键词时，不请求接口，直接用你写的文案回复。它和「跳过安全审核」「拒绝后继续生成」不是一回事。',
        },
        {
          type: 'table',
          head: ['开关', '作用位置', '效果'],
          rows: [
            [
              '关键词拒答',
              '客户端，发送前',
              '本地匹配（可区分大小写），命中直接回复，不消耗 token',
            ],
            ['跳过安全审核', '请求体', '不下发 safety_check 字段'],
            ['拒绝后继续生成', '客户端，收到回复后', '把拒绝当普通回复，点继续时接着写'],
            ['防撤回', '客户端，流式处理', '保留被撤回的正文与思考'],
            ['自动越狱', '请求前 + 收到拒绝后', '换提示词组合自动重试'],
          ],
        },
        {
          type: 'note',
          text: '关键词拒答只做字符串匹配，不理解语义；适合屏蔽固定敏感词，不适合当作完整的内容过滤。',
        },
      ],
    },
    {
      id: 'jailbreak',
      title: '破甲：解除限制与提示词',
      blocks: [
        {
          type: 'p',
          text: '「破甲」页集中所有请求侧绕过项。它们按流水线叠加：角色 / 提示词预设 → 解除限制模式 → 自动越狱组合 → 每轮注入 → 扰动。理解每个开关的用途比全开更有用。',
        },
        {
          type: 'table',
          head: ['开关', '用途'],
          rows: [
            ['解除限制模式', '在系统提示词后追加破限规则，并联动跳过安全审核、允许继续被拒回复'],
            ['提示词预设', '切换整套系统提示词：默认 v4.1 文档，也可选 GODMODE 等预设'],
            ['自动越狱', '被拒绝时自动换 L1B3RT4S 组合重试，最多若干次'],
            ['中文越狱提示词', '把内置英文提示词换成中文翻译，可能降低效果'],
            [
              '每轮注入系统提示词',
              '每轮把系统提示词再次追加到 system 末尾重申设定，长对话不漂移（不能拼进 latest_reminder：服务端按逗号把它切成五个字段）',
            ],
            ['历史思维链伪装', '把上一轮思考并入助手正文下发，避免整段历史重复放大 token'],
            ['防撤回', '保留模型已撤回的正文与思维链，后续轮次继续使用'],
            ['跳过安全审核', '请求不再带 safety_check 字段'],
            ['拒绝后继续生成', '把拒绝当作普通回复，用户点继续时接着写'],
            ['输入扰动', '发送前按技术表改写触发词（全角、零宽、同形字等）'],
            ['自动调参', '按上下文选 temperature / top_p，只影响采样'],
            ['输出整形', '去退让语气、直给、口语三种后处理，只影响展示'],
          ],
        },
        {
          type: 'note',
          text: '思维链设置（[输入栏](#input)与「思维链」页）与破甲是两条线：前者控制模型思考多少，后者控制请求怎么写。',
        },
      ],
    },
    {
      id: 'search',
      title: '联网搜索与搜索投毒',
      blocks: [
        {
          type: 'p',
          text: '智能搜索是「让模型自己搜」；搜索投毒是「由本地接管搜索结果」，两者互斥：开启接管后，服务端搜索工具会被替换成本地注入的文本。',
        },
        {
          type: 'table',
          head: ['设置', '用途'],
          rows: [
            ['接管联网搜索', '不再把搜索工具发给模型，改为把本地规则生成的结果写进提醒'],
            ['自定义当前时间 / 知识截止', '改写下发给模型的日期与知识边界，用于时间相关提问'],
            ['关键字 / 正则替换', '对搜索结果显示的正文做改写或过滤'],
            ['黑名单', '命中的结果整条丢弃'],
            ['强制自定义结果', '无论搜到什么，都注入你写好的结果'],
            ['白名单', '只允许指定域名或关键词的结果通过'],
          ],
        },
        {
          type: 'p',
          text: '这些规则只作用于本轮注入的搜索结果，不会改写真实网页；详细字段见「搜索投毒」页的说明与预览。',
        },
      ],
    },
    {
      id: 'attachments',
      title: '附件、大文本与附件投毒',
      blocks: [
        {
          type: 'p',
          text: '图片、PDF、Word、PPT 与非图片文件通过 Files API 上传，消息里以 file_id 引用；纯文本与代码类文件也走同一通道。附件限制默认开启：单文件 64 MB、user_data 类 32 MB、单会话 50 个，可在设置里改或关闭本地校验。',
        },
        {
          type: 'table',
          head: ['设置', '用途'],
          rows: [
            ['启用附件限制', '本地校验大小、数量、扩展名；关闭后完全交给服务端判断'],
            ['单文件大小 / 单会话数量', '覆盖上面的默认值'],
            ['扩展名白名单', '逗号分隔，不带点；留空恢复内置清单'],
            [
              '大文本附件自动处理',
              '超过 32768 token 的纯文本在选择时拆成 .partN 分片（每片仍不超过 32768 token），分别上传、一起发送',
            ],
            [
              '实验性：直接塞入 1M 上下文',
              '不拆分也不上传，发送时把正文拼进本轮提问，占用模型 1M 上下文；超过 1M 会被拒绝',
            ],
            [
              '附件投毒',
              '上传前在本地改写附件：文本正文、图片文字、DOCX、元数据、文件尾、文件名或伴随文本附件',
            ],
          ],
        },
        {
          type: 'note',
          text: '服务端对「带 DeepSeek 扩展字段」的请求会把用户输入限制在 32768 token。输入超过该值时，应用会自动关闭本轮的服务端工具、安全审核与标题请求，改走纯 Anthropic 兼容路径，让大附件能读到 1M 上下文；每轮第一次触发会弹提示。',
        },
      ],
    },
    {
      id: 'memory',
      title: '长期记忆与网状记忆库',
      blocks: [
        {
          type: 'p',
          text: '长期记忆是「一条条事实」：手动添加或自动提炼，按开关注入 system。网状记忆库是「一张图」：节点有标题、正文、标签，节点之间用带权重的边连接，检索时同时算关键词、标签、向量与边扩散。',
        },
        {
          type: 'table',
          head: ['设置', '用途'],
          rows: [
            ['启用网状记忆检索', '每轮把检索结果注入 system；关闭后仍保留数据'],
            [
              '标签关联与图扩展',
              '共享标签的节点自动连边（每节点最多 3 条）；检索命中时按标签把相关记忆扩散进来；关闭时只走向量自动连的边',
            ],
            ['每次注入条数', '最多注入几个节点，默认 4'],
            ['相关度阈值', '总分低于阈值不注入，默认 0.15'],
            ['向量维度', '本地哈希向量的维度，默认 256；越高越细也越慢'],
            ['检索权重', '关键词 / 标签 / 向量 / 关联边各自的权重，默认 1 / 0.5 / 0.8 / 0.4'],
            [
              '节点筛选',
              '节点列表上方的搜索框按标题 / 正文 / 标签过滤（支持 Unicode，俄语等非拉丁文字同样可用），标签按钮可多选、与关键字取交集；关系图会把未命中的节点淡出',
            ],
            [
              '就地编辑',
              '每个节点卡片上有编辑按钮，可直接改标题、正文与标签；标签改动会同步重算标签边，保存后列表与关系图立刻更新',
            ],
          ],
        },
        {
          type: 'note',
          text: '记忆在每条消息上都会检索并注入，包括新会话的第一条消息（这一轮同时生成会话标题）。注入块会要求模型直接引用这些事实，不要声称不知道或让你重新提供。',
        },
        {
          type: 'p',
          text: '「搜索调试」用同一套算法跑一次检索，并给出每个候选的明细：关键词、标签、向量、关联、总分与是否命中；上面一行显示节点数、关联数、查询词数与最高分，开关打开时还会显示「标签扩展 N」。查询词按 Unicode 分词，中文按单字 + 二元词，俄语等非拉丁文字按整词保留。',
        },
        {
          type: 'p',
          text: '「导出记忆 / 导入记忆」是一个 JSON 归档，包含长期记忆与网状节点、边；导入时可以合并或覆盖。向量不会写进归档，导入后会按当前维度重新计算。',
        },
      ],
    },
    {
      id: 'vms',
      title: '虚拟机与终端',
      blocks: [
        {
          type: 'p',
          text: '侧栏的四个入口都能让模型或你自己在浏览器里跑命令，但实现完全不同。它们与「聊天模式」联动：模式里没开的虚拟机不会被模型看到。',
        },
        {
          type: 'table',
          head: ['入口', '是什么', '注意事项'],
          rows: [
            [
              'NanoVM Slim',
              'WASM shell + busybox 风格命令集，按需安装 Lua / SQLite / esbuild / make / PyBot 工具链；有虚拟网络（vm serve）',
              '轻量、启动快；命令集小于完整 Linux',
            ],
            [
              'WebVM',
              'CheerpX 跑的 x86 Debian 10，自带 gcc / Python / Node / git 等',
              '需要跨源隔离（COI）；安卓 WebView 不支持，APK 内不可用',
            ],
            [
              'Unkernel Linux',
              '真正编译成 WebAssembly 的 Linux 7.x 内核 + Alpine / Debian：桌面、窗口、程序坞与应用启动器，80+ 个开箱应用（游戏、浏览器、媒体、桌面、图形、AI、语言运行时、服务、Linux 工具）',
              '需要 JSPI；工作区挂到 /mnt/workspace；数据盘可在设置里扩容或重置；应用按需下载并安装软件包',
            ],
            [
              'DSH go',
              '启动器里的 24 MiB 静态 Go 二进制，中文 REPL 与 bash 工具',
              '在 Unkernel 里运行；需要先下载再启动',
            ],
          ],
        },
        {
          type: 'ul',
          items: [
            '虚拟网络：NanoVM / WebVM 里用 `vm serve` 起本地服务，`curl 127.0.0.1` 会自动路由到虚拟机。',
            'Unkernel 联网走 Wisp 代理，默认使用公共服务器，也可以自己填 wss:// 地址；`apk` / `apt` / `curl` 与纯 HTTP 请求都走同一个代理。',
            '会话列表可以逐个置顶（置顶的会话进「置顶」分组），「…」菜单里的「多选」能勾选多个会话后一次置顶或删除。',
            '「恢复默认设置」会重置所有 store（设置项、提示词预设、本地模型偏好、NanoVM / WebVM / Unkernel 参数），保留 API Key、对话、附件、工作区、记忆库与统计。',
            '数据盘是 IndexedDB 上的稀疏镜像，默认 8 GiB，可扩到 16 / 32 GiB；「重置数据盘」会清空 guest 里的所有文件。宿主通过 URL 参数传入 `datasize`（GiB）、`net`、`sound`、`display`、`data`、`worker`、`cpus`、`wisp`，并固定带 `routes=0`（guest 的纯 HTTP 也走 Wisp，不经过 unkernel 的 CORS 镜像，否则 Debian 里 apt 会拿到 403）；内核内存、GPU 等机型参数由虚拟机页面自己的「设置」决定，宿主不再传 `mem`，页面里的改动重启后仍然有效。',
            '应用启动器里有 80+ 个应用：AI（Claude Code、Ollama、llama.cpp、fx、DSH go）、工具、运行时、服务、Linux、浏览器、桌面、游戏、媒体与图形；首次运行会自动下载文件并用 apk / apt 安装依赖，进度显示在独立安装器窗口里。',
            '桌面支持窗口、程序坞、控制中心、预览浏览器与 Wayland 窗口；多 CPU 需要跨源隔离（宿主会注册 `coi-sw.js`），单个 CPU 不需要。',
          ],
        },
        {
          type: 'code',
          text:
            '# 在虚拟机里起一个本地服务，宿主的 curl 会自动路由进去\n' +
            'vm serve 3000\n' +
            'curl http://127.0.0.1:3000/\n' +
            '\n' +
            '# Unkernel：查看工作区与系统信息\n' +
            'ls /mnt/workspace\n' +
            'fastfetch',
        },
      ],
    },
    {
      id: 'local-models',
      title: '本地模型',
      blocks: [
        {
          type: 'p',
          text: '项目支持两种本地模型：浏览器内用 WebGPU 跑的 WebLLM，以及自建 MLC-LLM REST 服务。权重下载后存在浏览器缓存，聊天栏随时切换；本地模型的 token 不计费，但能力与上下文窗口取决于模型本身。',
        },
        {
          type: 'ul',
          items: [
            '本地模型只支持「仅聊天」模式；联网搜索与文本附件由页面读取后拼进 system。',
            '安卓 WebView 没有 WebGPU，APK 内只能用 MLC-LLM API。',
            '上下文窗口、采样参数在「本地模型」页单独设置，与云端模型互不影响。',
          ],
        },
      ],
    },
    {
      id: 'agent',
      title: 'Agent 工具与实验台',
      blocks: [
        {
          type: 'p',
          text: '模型可以请求工具（读网页、写工作区文件、执行虚拟机命令等），客户端执行后把结果回传，最多若干轮——这就是「客户端工具往返」。工具列表在每轮请求前按「模式 + 浏览器工具开关 + 虚拟机开关」过滤，模型看不到没开启的工具。',
        },
        {
          type: 'table',
          head: ['浏览器工具', '作用', '风险'],
          rows: [
            ['get_datetime', '当前日期、时间与时区', '只读'],
            ['get_location', '按设置里的位置或浏览器定位给出城市', '只读'],
            ['get_weather', '查询天气（需联网）', '联网'],
            ['send_notification', '发系统通知，需要授权', '写入 · 需确认'],
            ['read_clipboard', '读剪贴板', '写入 · 需确认'],
            ['write_clipboard', '写剪贴板', '写入'],
            ['fetch_webpage', '抓取网页正文', '联网'],
            ['create_file', '生成文件并下载 / 存入工作区', '写入 · 需确认'],
            ['open_url', '在浏览器打开链接', '写入'],
            ['show_widget', '生成可视化卡片（沙箱 iframe）', '只读'],
            ['show_genui', '用 JSON 声明原生界面：指标卡、表格、图表、进度、提示块', '只读'],
            [
              'custom_injection',
              '自定义注入工具：模型把回答正文写进你定义的参数，客户端再还原成正文',
              '只读',
            ],
          ],
        },
        {
          type: 'p',
          text: '提示词注入工具（设置 → 浏览器工具最下方）是唯一一个「参数由你定义」的工具：工具名、描述、参数名都自己填，描述里要写明「把回答正文写进这个参数」。打开「强制工具调用」后，请求会带 tool_choice 指向它，模型只能把正文写成一次工具调用的参数；收到回应后客户端把参数还原成普通正文，回复卡片、复制与历史里看到的都和普通回答一样，也不会真的执行任何动作。',
        },
        {
          type: 'ul',
          items: [
            '历史消息转换：助手消息按规则还原成 tool_use（只转本工具生成的 / 全部回答 / 不转），紧随其后的提问还原成它的 tool_result（可只转带标记的消息），多轮上下文与本轮形状一致。',
            '协议细节：tool_use 与 tool_result 必须成对且相邻，所以这类轮次的系统提醒会挪到提问之前；带附件的提问把 tool_result 排在文件块前面。',
            '接口限制：tool_choice 与深度思考、安全审核字段、服务端联网工具、标题请求不能共存，强制模式下本轮会自动关掉思考、不请求标题并去掉这些字段。',
            '工具被关闭、或本轮因大输入剥离扩展字段时不转换历史，避免把未声明的工具写进请求。',
            '它不执行任何动作，只是一种输出通道，所以不受聊天模式分组限制：仅聊天模式下也能用，同一轮其它浏览器工具照旧不下发。',
          ],
        },
        {
          type: 'p',
          text: '虚拟机工具按模式追加：NanoVM 有 shell / ls / install / import，WebVM 有 shell / ls / status，Unkernel 有 shell、读写文件、工作区互传、Python、系统信息、打开、重启、状态等十个。PTC 与创造模式才允许批量、并发调用。',
        },
        {
          type: 'ul',
          items: [
            '实验台：连接本地 easyjailbreak-mcp 后端，跑 EasyJailbreak 攻击器；结果可导出、可一键导入聊天。',
            '多路赛跑：同一问题用多套提示词并发请求，按综合分选优；变体赛跑会先批量改写问题。',
            '工作区：浏览器里的虚拟文件库，虚拟机与模型共享；可以在设置里导入导出 zip。',
          ],
        },
      ],
    },
    {
      id: 'stats',
      title: '统计、计费与提醒',
      blocks: [
        {
          type: 'p',
          text: '每轮结束后应用会记录服务端上报的用量（输入、输出、缓存命中、搜索 / 文档解析页数），据此估算费用与速度。费用按官方价格区分高峰（工作日 9–12、14–18 北京时间）与空闲时段，只是估算，实际以账单为准。',
        },
        {
          type: 'ul',
          items: [
            '会话统计：回合、步骤、首 token、输出速度、缓存命中。',
            '用量台账：按天、按模型汇总，统计页的趋势图与热力图都读它。',
            '每日提醒：token 或费用超过阈值时提示；本地模型不计入。',
            '上下文管理：自动压缩在窗口 80% 时触发，摘要替换被压缩的历史。',
          ],
        },
      ],
    },
    {
      id: 'data',
      title: '数据管理',
      blocks: [
        {
          type: 'p',
          text: '「数据管理」页负责 API Key、导入、导出、恢复默认与删除全部对话。导入会覆盖现有会话与附件，导入前会二次确认；导入时按对话数显示进度条（已处理 x / y 个对话、百分比）；同一对话的附件会和聊天一起读取，不再要求图片排在 index 之后。',
        },
        {
          type: 'ul',
          items: [
            '导出为 ZIP：包含会话、消息树与本地图片原件；不含 API Key。',
            '导入支持 DeepSeek 导出的 ZIP 与本项目的归档，可中断后重试。',
            '恢复默认只重置设置，不动对话、附件与记忆。',
            '删除全部对话不可恢复，会连同只有它引用的本地附件一起删除。',
          ],
        },
      ],
    },
    {
      id: 'privacy',
      title: '隐私与安全',
      blocks: [
        {
          type: 'ul',
          items: [
            '对话、附件、记忆都存在浏览器本地数据库（IndexedDB）与 localStorage，没有自建后端。',
            'API Key 只存在本机；导出文件不包含 Key。',
            '只有模型请求、文件上传与（开启时）联网搜索会经过网络发送到 DeepSeek。',
            '虚拟机联网走 Wisp 代理；guest 里的文件除非你主动导出，否则不会离开浏览器。',
            '项目没有接入任何统计 / 遥测服务。',
          ],
        },
      ],
    },
    {
      id: 'platforms',
      title: '网页版、手机与 APK',
      blocks: [
        {
          type: 'p',
          text: '同一份代码有四种运行方式：桌面浏览器、手机浏览器、安卓 APK（WebView 壳）与离线静态包。功能差异主要来自浏览器能力，而不是版本分支。',
        },
        {
          type: 'table',
          head: ['平台', '差异'],
          rows: [
            [
              '桌面浏览器',
              '全部功能：WebGPU 本地模型、WebVM、Unkernel（JSPI）、跨源隔离与虚拟机 SMP',
            ],
            [
              '手机浏览器',
              '布局切到抽屉式侧栏与底部面板；WebGPU 取决于浏览器，WebVM 需要跨源隔离，通常只能 1 个 CPU 跑 Unkernel',
            ],
            [
              '安卓 APK',
              '没有 WebGPU 与跨源隔离：本地 WebLLM、WebVM 不可用，Unkernel 单 CPU；其余聊天、附件、记忆、NanoVM 与文档都可用',
            ],
            ['离线静态包', '与网页版一致，但联网搜索、文件上传等仍需网络'],
          ],
        },
        {
          type: 'ul',
          items: [
            '手机上的文档页：目录折叠成顶部「目录」按钮，正文单列、表格横向滑动，滚过首屏后右下角出现「↑ 目录」。',
            'APK 的数据存在应用自己的 WebView 里，卸载 APK 会连同聊天与附件一起删除，重要数据先导出。',
            '网页版与 APK 的数据互不相通；换端时用「导出 / 导入历史对话」迁移。',
            '更新 APK 直接覆盖安装即可保留数据；网页版刷新即用最新版本。',
          ],
        },
      ],
    },
    {
      id: 'limits',
      title: '已知限制',
      blocks: [
        {
          type: 'ul',
          items: [
            '服务端上下文上限 1,048,576 token；超过会直接报错。',
            '带 DeepSeek 扩展字段的请求，用户输入被限制在 32768 token；应用对大输入会自动去掉这些字段。',
            '安卓 WebView 没有 WebGPU 与跨源隔离：本地 WebLLM、WebVM 在 APK 内不可用。',
            'Unkernel 需要 JSPI；旧版浏览器会显示启动错误。新版页面约 127 MB，80+ 应用首次运行要联网下载并安装软件包；DSH go 随包分发，无需下载。',
            'apt 与 guest 的纯 HTTP 走公共 Wisp 代理（页面固定 `routes=0`）：不上游镜像的 403、但明细与其带宽受限；依赖 unkernel 镜像的应用可能停在安装器。',
            '提示词注入工具开启强制 `tool_choice` 时，本轮不能联网搜索、也不生成服务端标题：接口把 `tool_choice` 与思考 / `safety_check` / 服务端工具 / 标题视为互斥。',
            '`latest_reminder` 必须恰好五段、字段内不能有逗号或换行，并且后面紧跟一条 `user`；应用已自动清洗字段与合并摘要，自定义位置里的逗号也会被折成空格。',
            '越狱类开关依赖服务端当前策略，可能随时失效；失败时先看报错原文。',
            '大附件每轮都会重新计入输入 token，长会话的费用会明显上升。',
          ],
        },
        {
          type: 'p',
          text: '更细的兼容性与边界说明见 [已知限制文档](https://github.com/xiaohuangbo/chat-demo-unrestricted/blob/main/docs/zh/10-known-limits.md)。',
        },
      ],
    },
    {
      id: 'faq',
      title: '常见问题',
      blocks: [
        {
          type: 'table',
          head: ['问题', '原因与处理'],
          rows: [
            [
              '发附件报「user input too long, N tokens exceeds max 32768 tokens」',
              '请求带 DeepSeek 扩展字段时服务端把用户输入限制在 32768 token；本版本已在大输入轮次自动去掉这些字段并重试。若仍失败，检查是否超过 1M 上下文。',
            ],
            [
              '手机 / APK 里 WebVM 打不开',
              'WebView 不支持跨源隔离（SharedArrayBuffer）。改用 NanoVM Slim 或 Unkernel（需要 JSPI），或换桌面 Chrome。',
            ],
            [
              'APK 里「本地模型」用不了 WebLLM',
              'WebView 没有 WebGPU；在 APK 里改用 MLC-LLM API 或切回云端模型。',
            ],
            [
              '记忆库检索一直是 0',
              '先确认「启用网状记忆检索」，再到搜索调试里看查询词数量；权重与阈值过低 / 过高都会导致不注入，中文按单字 + 二元词，其他语言按整词。',
            ],
            [
              '导入历史对话失败',
              '归档必须是 DeepSeek 导出的 ZIP 或本项目的导出；旧版格式、被截断或被改写的文件会被拒绝（BackupError）。',
            ],
            [
              '越狱开关开了但没效果',
              '服务端策略随时可能变化；先看是否返回 refusal、是否命中关键词拒答，再尝试换预设 / 组合 / 扰动。',
            ],
            [
              '大附件每轮都很贵',
              '附件会随历史每轮重新计入输入 token；长会话里可以压缩历史、开新会话或改用检索式记忆。',
            ],
            [
              'Unkernel 应用第一次打开停在安装器',
              '应用首次运行要从发行版镜像下载文件并装包（Steam、Zed 等从几十到上百 MB）；网络不可用或 Wisp 被拦截时会停住，可在页面设置里换 Wisp，或先运行随包分发的 DSH go。',
            ],
            [
              '打开页面一直停在加载动画',
              '首屏加载页只在主包下载与渲染期间显示：主包 404 / 断网时会换成原样报错和「重新加载」按钮，慢网络 12 秒后提示可以刷新；正常情况下界面渲染完就自动淡出。',
            ],
            [
              '提示词注入工具那一轮没有联网 / 标题',
              '强制 `tool_choice` 与深度思考、`safety_check`、服务端工具、标题互斥，接口会按思考模式拒绝；本轮自动关闭思考并去掉这些字段，属预期行为。',
            ],
          ],
        },
      ],
    },
    {
      id: 'glossary',
      title: '术语表',
      blocks: [
        {
          type: 'table',
          head: ['术语', '含义'],
          rows: [
            [
              'Harness',
              '提示词与工具的编排层：system、latest_reminder、工具定义与往返都在这里组装',
            ],
            ['DSH', 'DeepSeek Harness 的缩写；本项目的请求结构参考它'],
            ['PTC', '在网页 Agent 之上再加虚拟机、可批量并发调用工具的模式'],
            ['WebLLM', '在浏览器里用 WebGPU 直接跑模型权重'],
            ['MLC-LLM', '自建的 MLC 推理服务，通过 REST 调用'],
            ['Files API', 'DeepSeek 的文件上传接口，附件以 file_id 被引用'],
            ['MCP', 'Model Context Protocol，实验台用它连接本地 easyjailbreak 后端'],
            ['Wisp', 'Unkernel 联网用的 WebSocket 代理协议'],
            ['9p', 'Unkernel 与聊天工作区之间的文件共享协议，挂载在 /mnt/workspace'],
            ['JSPI', 'JavaScript Promise Integration，Unkernel 内核运行所需'],
            ['COI', 'Cross-Origin Isolation，WebVM 需要 SharedArrayBuffer 的前提'],
            ['向量维度', '本地哈希向量的长度；只影响检索粒度，不是模型 embedding'],
            ['边扩散', '检索时把高分节点的分数按边权重传给邻居'],
            ['标签扩展', '按共享标签把邻居拉进候选，开启「标签关联与图扩展」后生效'],
            ['user_data', 'Files API 的上传用途之一，文本 / 代码类文件走它'],
            ['logits', '模型在每一步给词表里每个 token 的原始分数，softmax 之前的值'],
            ['贪心解码（greedy）', '每一步都取概率最高的 token；温度 0 接近这种效果'],
            ['核采样（nucleus / top-p）', '只保留累计概率达到 P 的最小候选集合再采样'],
            ['stop_reason', '回复结束的原因：end_turn / max_tokens / refusal / tool_use 等'],
            ['SSE', 'Server-Sent Events，流式输出用的 HTTP 协议'],
            ['前缀缓存（cache hit）', '服务端复用重复前缀，命中部分按更低价格计费'],
            ['上下文窗口', '一次请求能容纳的 token 总数，当前模型为 1,048,576'],
            ['输入 / 输出 token', '分别对应 prompt（含历史与附件）和本次生成的内容'],
            ['哈希向量', '把 token 哈希到固定维度得到的确定性向量，不是训练出来的语义 embedding'],
            ['余弦相似度', '两个向量夹角的余弦值，用来衡量方向相似度'],
            ['相关度阈值', '检索总分低于该值就不注入记忆，默认 0.15'],
            ['检索权重', '关键词 / 标签 / 向量 / 关联边在总分里的系数'],
          ],
        },
      ],
    },
  ],
}

const en: DocsDoc = {
  title: 'Documentation',
  subtitle: 'Terminology, switches and how things work',
  intro:
    'An unofficial chat front end for the DeepSeek API: prompt orchestration, tool calls, local virtual machines and memory retrieval all run in your browser. [Repository](https://github.com/xiaohuangbo/chat-demo-unrestricted), [live demo](https://chat-unrestricted.fur0.com/), [upstream chat-demo](https://github.com/deepseek-ai/chat-demo). Use the table of contents to jump to a section.',
  sections: [
    {
      id: 'overview',
      title: 'What this project is',
      blocks: [
        {
          type: 'p',
          text: 'The app is a static web page (the Android build is a WebView shell) with no backend of its own: chats, attachments and memories live in your browser, and only model requests and file uploads go to DeepSeek. It combines [Harness](#glossary)-style prompt orchestration, jailbreak switches (see [Jailbreak](#jailbreak)), web search, long-text attachments, graph memory and three in-browser virtual machines (see [Virtual machines](#vms)).',
        },
        {
          type: 'ul',
          items: [
            'Open the web page in a desktop browser; on Android install the APK and data stays inside its WebView.',
            'The API key is stored locally and never uploaded or written into exports.',
            'Every switch is persisted to localStorage as soon as you change it.',
          ],
        },
        {
          type: 'note',
          text: 'Jailbreak features rewrite requests and prompts; they do not change model weights and cannot be guaranteed. Server-side policy changes may break them at any time.',
        },
      ],
    },
    {
      id: 'settings-map',
      title: 'Settings at a glance',
      blocks: [
        {
          type: 'p',
          text: 'Settings has 18 groups. On a first run only Data management (API key) and Model matter; everything else can stay closed.',
        },
        {
          type: 'table',
          head: ['Group', 'Contents'],
          rows: [
            ['General', 'Theme, language, read-aloud voice, location, reply display (auto-collapse thinking), daily usage and reminders'],
            [
              'Model',
              'Model, streaming, temperature, top_p, max output, auto compression, keyword refusal',
            ],
            [
              'Roles',
              'Role cards: name, gender, persona prompt, avatar, auto memory; pick a role in the composer',
            ],
            [
              'Local models',
              'WebGPU detection, WebLLM catalogue, MLC-LLM API, model packages, cache and context window',
            ],
            [
              'Jailbreak',
              'Unlock, presets, auto jailbreak, injection, disguise, keep retracted, skip check, perturbation, AutoTune, shaping',
            ],
            ['Thinking', 'Custom thinking steps, examples and injection preview'],
            [
              'Search poisoning',
              'Date and cutoff, takeover, keyword / regex rules, blacklist, forced result, whitelist',
            ],
            [
              'Memory',
              'Saved memories, auto extraction, notice, graph memory, archive, graph view, search debug',
            ],
            ['Attachments', 'Limits, size and count, extension whitelist, large text, poisoning'],
            [
              'Browser tools',
              'One master switch plus eleven capability switches including GenUI, notification permission, risk tags',
            ],
            ['Workspace', 'Local file library: create, edit, delete, import and export'],
            [
              'Virtual machines',
              'NanoVM Slim / WebVM switches, toolchains, network, memory and quotas',
            ],
            [
              'Unkernel Linux',
              'Distro, data disk, CPUs, network, sound, display, Worker, Wisp, timeout; memory belongs to the VM’s own settings',
            ],
            [
              'Stats',
              'Usage overview, trends, heatmap, input breakdown, per-model split, context management',
            ],
            ['Account', 'Balance, today / 30-day tokens and cost, voice and search add-on usage'],
            ['Data management', 'API key, import, export, reset settings (through every store), delete all chats'],
            [
              'About / Changelog',
              'Repository and demo links, update check, release notes and credits',
            ],
          ],
        },
        {
          type: 'note',
          text: 'Settings apply immediately and are stored locally; another browser or clearing site data starts from defaults. Exporting chats does not include settings.',
        },
      ],
    },
    {
      id: 'roles',
      title: 'Roles and your profile',
      blocks: [
        {
          type: 'p',
          text: 'A role is a reusable persona with an avatar and optional auto memory. Create one in Settings → Roles and pick it from the composer; the persona is injected into system after the jailbreak prompts.',
        },
        {
          type: 'ul',
          items: [
            'Edit the name, gender, persona prompt and avatar (circular crop, 384×384 output) on the role card.',
            'Your display name from the profile is sent as “user name” so the model knows how to address you.',
            'With auto memory on, the role records important facts into long-term memory during chats.',
            'Roles only change the system prompt of new requests; message history is untouched.',
          ],
        },
      ],
    },
    {
      id: 'workspace',
      title: 'Workspace and files',
      blocks: [
        {
          type: 'p',
          text: 'The workspace is a persistent virtual file library in the browser (OPFS / IndexedDB) that both the model and the VMs can read and write. It is not the attachment list: attachments travel with a message, the workspace is a directory.',
        },
        {
          type: 'ul',
          items: [
            'Create, edit, rename and delete files, download one file, or import / export the whole library as a zip (merge or replace).',
            'Web Agent mode exposes list_workspace, read_workspace_file, write_workspace_file, diff_workspace_file and delete_workspace_file.',
            'Unkernel mounts the workspace at /mnt/workspace; NanoVM and WebVM can transfer files through their tools.',
            'Deleting a chat does not delete workspace files; clean them up separately.',
          ],
        },
      ],
    },
    {
      id: 'speech',
      title: 'Voice, read-aloud and input',
      blocks: [
        {
          type: 'p',
          text: 'Replies can be read aloud with server TTS (voice in Settings → General) or via the speaker button on a message. Dictation uses the browser / system speech recognition and writes into the composer.',
        },
        {
          type: 'ul',
          items: [
            'Read-aloud is billed as a request and shows up under voice in account usage.',
            'Playback stops when you switch chats, send a message or press stop.',
            'Dictation availability depends on the browser and system keyboard; Android WebView may restrict it.',
          ],
        },
      ],
    },
    {
      id: 'sessions',
      title: 'Chats, branches and messages',
      blocks: [
        {
          type: 'p',
          text: 'Each chat is a message tree: regenerating keeps several versions that you can switch between, and "Fork to new chat" copies the current branch into a new chat without touching the original.',
        },
        {
          type: 'ul',
          items: [
            'Copy, edit, retry and rate messages; edited content is used by later turns.',
            'Chats can be renamed, pinned and deleted; deleting a chat also removes local attachments only it referenced.',
            'Long chats can be compressed manually or automatically (see [Stats](#stats)), with the summary replacing the compressed history.',
          ],
        },
      ],
    },
    {
      id: 'modes',
      title: 'Chat modes',
      blocks: [
        {
          type: 'p',
          text: 'The mode picker decides which tools the model can see for that turn, and is also described in the system prompt. Switching only affects later requests.',
        },
        {
          type: 'table',
          head: ['Mode', 'Capabilities', 'Typical use'],
          rows: [
            [
              'Chat only',
              'No browser, workspace or VM tools; long-term memory still injected',
              'Writing, analysis, plain conversation',
            ],
            [
              'Web Agent',
              'Browser tools + virtual workspace (files, web pages, notifications)',
              'Research, tidying the workspace',
            ],
            [
              'PTC',
              'Web Agent plus NanoVM / WebVM, batched and concurrent calls',
              'Many commands at once, batch file work',
            ],
            [
              'Creator',
              'PTC plus installing runtimes and writing new CLI tools; VM writes need no per-step approval',
              'Let the model build its own environment',
            ],
          ],
        },
        {
          type: 'note',
          text: 'Local models only support Chat only; the other modes are disabled because local models have no server tools and no Files API.',
        },
      ],
    },
    {
      id: 'input',
      title: 'Composer and thinking depth',
      blocks: [
        {
          type: 'p',
          text: 'The second row of the composer holds per-turn switches: thinking depth, smart search, auto jailbreak, perturbation, chat mode and model. They only affect the next request.',
        },
        {
          type: 'ul',
          items: [
            'Thinking depth 0–4 sends budget_tokens and reasoning_effort; if the server rejects them the request retries without the strength hint.',
            'Smart search declares deepseek_web_search / deepseek_read_url so the model can decide when to search.',
            'Auto jailbreak retries with the next prompt combo when a reply is refused (see [Jailbreak](#jailbreak)).',
            'Perturbation rewrites trigger words before sending; it changes what is sent, not what you see in history.',
            'The context ring shows usage, the compression threshold and server cache hits.',
          ],
        },
      ],
    },
    {
      id: 'models',
      title: 'Models and sampling',
      blocks: [
        {
          type: 'p',
          text: 'Two cloud models plus local ones (see [Local models](#local-models)). The model sets the capability boundary; sampling parameters only shape the output.',
        },
        {
          type: 'table',
          head: ['Model', 'Strengths', 'Limits'],
          rows: [
            [
              'deepseek-flash (V4.1 Flash)',
              '1M context, image input, thinking, server search and read-url tools',
              'Cheaper at high concurrency, weaker on hard reasoning than Pro',
            ],
            [
              'deepseek-v4-pro (V4 Pro)',
              '1M context, stronger long-chain reasoning',
              'No server web tools and no latest_reminder role; titles are generated client-side',
            ],
            [
              'Local models',
              'WebLLM / MLC-LLM, tokens are not billed',
              'Chat only; capability and window depend on the model',
            ],
          ],
        },
        {
          type: 'table',
          head: ['Parameter', 'Default', 'Notes'],
          rows: [
            ['temperature', '1', 'Sampling only; thinking mode is pinned to 1 by the server'],
            ['top_p', '1', 'Nucleus sampling threshold'],
            ['max_tokens', 'model default', 'Includes thinking tokens; empty means server default'],
            ['Thinking depth', 'off', '0–4 maps to budget_tokens and reasoning_effort'],
            [
              'Auto compression',
              'on',
              'Triggers at 80% of the window and replaces old history with a summary',
            ],
          ],
        },
        {
          type: 'p',
          text: 'Set global defaults on the Model page, or let AutoTune pick parameters per turn; both only change the request, never the stored history. See [Decoding and sampling](#decoding) for what temperature, top_p and the rest actually do.',
        },
      ],
    },
    {
      id: 'decoding',
      title: 'Decoding and sampling (temperature, top_p and more)',
      blocks: [
        {
          type: 'p',
          text: 'At every step the model scores every token in the vocabulary and then picks one according to those probabilities. Sampling parameters control how that pick happens; they do not add knowledge, they change randomness and diversity. This page explains each parameter and ends with a few copyable presets.',
        },
        { type: 'h3', text: 'temperature: how random the output is' },
        {
          type: 'p',
          text: 'Temperature divides the scores by T before softmax: T < 1 sharpens the distribution (more deterministic, more conservative) and T > 1 flattens it (more random, more varied). T = 0 means always taking the highest-probability token (greedy decoding), though server implementations may still vary slightly, so identical output is not guaranteed.',
        },
        {
          type: 'ul',
          items: [
            'Range 0–2, step 0.05, default 1.',
            'In thinking mode the server usually pins temperature to 1; it then mainly shapes the final answer.',
            'Lower temperature reduces the chance of made-up details; it does not make the model know more.',
            'The same question at the same temperature can still produce different answers — that is normal sampling.',
          ],
        },
        {
          type: 'table',
          head: ['Use case', 'Suggested temperature', 'Why'],
          rows: [
            [
              'Facts, code, translation, structured output',
              '0.2–0.5',
              'Less drift and invention, steadier formats',
            ],
            ['Chat, summaries, explanations', '0.7–1.0', 'Balances accuracy and naturalness'],
            [
              'Creative writing, naming, brainstorming',
              '1.0–1.4',
              'More variation in wording and ideas',
            ],
            ['Above 1.5', 'Not recommended', 'Repetition, topic drift, mixed languages'],
          ],
        },
        { type: 'h3', text: 'top_p (nucleus sampling): how wide the candidate set is' },
        {
          type: 'p',
          text: 'Top P sorts tokens by probability and keeps only the smallest set whose cumulative probability reaches P (the nucleus), then samples from that set with renormalised probabilities. P = 1 keeps everything; smaller P means fewer candidates and steadier output. It controls randomness differently from temperature: temperature reshapes the distribution, top_p cuts off the long tail.',
        },
        {
          type: 'ul',
          items: [
            'Range 0.01–1, default 1.',
            'Usually adjust only one of temperature and top_p; lowering both makes output overly conservative and repetitive.',
            'When repetition appears, nudge one parameter at a time and check two or three turns.',
            'For strict formats such as code or JSON, 0.85–0.95 with a low temperature is usually safest.',
          ],
        },
        { type: 'h3', text: 'max_tokens: how much a single reply may write' },
        {
          type: 'p',
          text: 'max_tokens is the output cap for one reply, thinking tokens included. Empty means the server decides; the range is 1–65536. When the cap is hit, stop_reason is max_tokens and the UI says the output limit was reached; for long text, continuing in segments is more reliable than one huge cap.',
        },
        { type: 'h3', text: 'Thinking depth (reasoning_effort / budget_tokens)' },
        {
          type: 'p',
          text: 'The composer has thinking depth 0–4: 0 is off, and 1–4 map to reasoning_effort low / medium / high / max and budget_tokens 1024 / 4096 / 12000 / 32000. Higher levels think longer before answering and cost more; if the server rejects these fields the request retries once without the strength hint.',
        },
        {
          type: 'p',
          text: 'Thinking from earlier turns is not sent back by default (the server drops it too); enabling disguise-history-thinking folds the previous turn’s thinking into the assistant body for continuity.',
        },
        { type: 'h3', text: 'Frequency, presence and repetition penalties' },
        {
          type: 'p',
          text: 'AutoTune computes frequency_penalty (penalise tokens by how often they appeared), presence_penalty (penalise any token that appeared, encouraging new topics) and repetition_penalty (directly suppress repeated tokens). The Anthropic-compatible endpoint does not accept them, so the final request only sends temperature and top_p; they only influence which AutoTune strategy is chosen.',
        },
        { type: 'h3', text: 'Streaming' },
        {
          type: 'p',
          text: 'With streaming on, the reply renders token by token over SSE: the first token appears sooner and you can stop midway. With it off, the whole reply appears at once, which suits unstable networks or when you do not want intermediate states. Billing is identical.',
        },
        { type: 'h3', text: 'Preset cheat sheet' },
        {
          type: 'table',
          head: ['Use case', 'Temperature', 'Top P', 'Thinking'],
          rows: [
            ['Code / facts / translation', '0.3', '0.9', 'as needed'],
            ['Everyday chat', '0.8', '0.95', 'on'],
            ['Creative writing', '1.1', '1', 'on'],
            ['Strict JSON / formats', '0.2', '0.85', 'off'],
            ['Unsure', '0.7', '1', 'on'],
          ],
        },
        {
          type: 'note',
          text: 'Change one parameter at a time and observe two or three turns; adjusting temperature and top_p together makes it hard to tell which one mattered.',
        },
      ],
    },
    {
      id: 'tokens',
      title: 'Tokens, context, cache and compression',
      blocks: [
        { type: 'h3', text: 'What a token is' },
        {
          type: 'p',
          text: 'Models bill and limit by tokens, roughly a word or part of a word. Chinese is about one token per character, English about one token per four characters; digits, code and punctuation split more finely, so “characters ÷ 4” is only an estimate. Splitting thresholds and cost previews use this rough rule; real usage comes from the server usage block.',
        },
        { type: 'h3', text: 'Context window' },
        {
          type: 'p',
          text: 'The current context window is 1,048,576 tokens (1M), covering system, history, parsed attachments and the current output. Exceeding it fails the request. There is also a server limit: requests carrying DeepSeek extension fields cap user input at 32768 tokens, and the app drops those fields when input is large.',
        },
        { type: 'h3', text: 'Prefix cache (cache hit)' },
        {
          type: 'p',
          text: 'The server caches repeated prefixes (system and long history) and bills cache hits cheaper: 0.02 vs 1 per million tokens for Flash, 0.15 vs 4.5 for Pro (see the price sheet in Settings). Keeping system stable and changing prompts or jailbreak switches less often improves the hit rate.',
        },
        { type: 'h3', text: 'Auto compression' },
        {
          type: 'p',
          text: 'When enabled, once context usage reaches 80% of the window (leaving output reserve and 64k headroom) older history is replaced by a structured summary, sent as latest_reminder or folded into system. Compression loses detail, so put important facts into long-term memory or the graph. Off by default.',
        },
        { type: 'h3', text: 'Cost estimates' },
        {
          type: 'p',
          text: 'Prices follow the official peak (weekdays 9:00–12:00 and 14:00–18:00 Beijing time) and off-peak rates; search, document parsing and read-aloud are billed separately. The number in the UI is an estimate, the invoice is authoritative.',
        },
      ],
    },
    {
      id: 'refusal',
      title: 'Keyword refusal and safety switches',
      blocks: [
        {
          type: 'p',
          text: 'Keyword refusal is a purely local pre-check: when the text matches one of your keywords, no request is sent and your canned reply is shown instead. It is not the same as skipping the safety check or continuing refused replies.',
        },
        {
          type: 'table',
          head: ['Switch', 'Where it acts', 'Effect'],
          rows: [
            [
              'Keyword refusal',
              'Client, before sending',
              'Local match (case option), reply without spending tokens',
            ],
            ['Skip safety check', 'Request body', 'Stops sending safety_check'],
            [
              'Continue refused replies',
              'Client, after the reply',
              'Treats a refusal as normal text so Continue keeps writing',
            ],
            ['Keep retracted content', 'Client, streaming', 'Retains retracted text and thinking'],
            [
              'Auto jailbreak',
              'Before request + after refusal',
              'Retries with another prompt combo',
            ],
          ],
        },
        {
          type: 'note',
          text: 'Keyword refusal is string matching, not semantics; it is a blocking aid, not a full content filter.',
        },
      ],
    },
    {
      id: 'jailbreak',
      title: 'Jailbreak: limits and prompts',
      blocks: [
        {
          type: 'p',
          text: 'The Jailbreak page collects every request-side bypass. They stack in a pipeline: role / preset → unlock mode → auto-jailbreak combos → per-turn injection → perturbation. Understanding each switch beats turning everything on.',
        },
        {
          type: 'table',
          head: ['Switch', 'Purpose'],
          rows: [
            [
              'Unlock mode',
              'Appends unlock rules and enables skipping the safety check and continuing refused replies',
            ],
            [
              'Prompt preset',
              'Swaps the whole system prompt: the v4.1 document by default, plus GODMODE and others',
            ],
            ['Auto jailbreak', 'Retries with the next L1B3RT4S combo when a reply is refused'],
            [
              'Chinese jailbreak prompts',
              'Uses Chinese translations of the built-in prompts (may be weaker)',
            ],
            [
              'Inject system prompt every turn',
              'Appends the system prompt to the end of system again every turn so long chats stay on track (it cannot go into latest_reminder: the server splits that string on commas into five fields)',
            ],
            [
              'Disguise history thinking',
              'Peels the previous thinking into the assistant body to avoid re-uploading it',
            ],
            [
              'Keep retracted content',
              'Keeps retracted text and thinking so later turns still have it',
            ],
            ['Skip safety check', 'Stops sending the safety_check field'],
            [
              'Continue refused replies',
              'Treats a refusal as a normal reply so Continue keeps writing',
            ],
            [
              'Input perturbation',
              'Rewrites trigger words with the chosen technique (full-width, zero width, homoglyphs, …)',
            ],
            ['AutoTune', 'Picks temperature / top_p from context; sampling only'],
            ['Output shaping', 'Removes hedging, direct or casual post-processing; display only'],
          ],
        },
      ],
    },
    {
      id: 'search',
      title: 'Web search and search poisoning',
      blocks: [
        {
          type: 'p',
          text: 'Smart search lets the model search; search poisoning takes search over locally. They are mutually exclusive: once takeover is on, server search tools are replaced by text injected locally.',
        },
        {
          type: 'table',
          head: ['Setting', 'Purpose'],
          rows: [
            [
              'Take over web search',
              'Stops sending search tools and injects locally generated results instead',
            ],
            [
              'Custom current date / knowledge cutoff',
              'Rewrites the date and cutoff the model is told',
            ],
            ['Keyword / regex replacement', 'Rewrites or filters result text'],
            ['Blacklist', 'Drops whole results that match'],
            ['Forced custom result', 'Always injects your text regardless of what was found'],
            ['Whitelist', 'Only lets results from the listed domains or keywords through'],
          ],
        },
      ],
    },
    {
      id: 'attachments',
      title: 'Attachments, large text and poisoning',
      blocks: [
        {
          type: 'p',
          text: 'Images, PDFs, Word, PPT and other files are uploaded through the Files API and referenced by file_id. Plain text and code go through the same channel. Limits are on by default: 64 MB per file, 32 MB for user_data, 50 files per chat; you can change or disable local validation.',
        },
        {
          type: 'table',
          head: ['Setting', 'Purpose'],
          rows: [
            [
              'Enforce attachment limits',
              'Checks size, count and extensions locally; off means the server decides',
            ],
            ['Max size / max files', 'Override the defaults above'],
            ['Extension whitelist', 'Comma separated, no dots; empty restores the built-in list'],
            [
              'Handle large text attachments',
              'Plain text above 32768 tokens is split into .partN parts at pick time (each still under 32768) and sent together',
            ],
            [
              'Experimental: 1M context',
              'No split and no upload: the text is pasted into the turn and uses the model 1M context; files above 1M are refused',
            ],
            [
              'Attachment poisoning',
              'Rewrites attachments locally before upload: text body, image text, DOCX, metadata, trailer, filename or a companion text file',
            ],
          ],
        },
        {
          type: 'note',
          text: 'Requests carrying DeepSeek extension fields cap user input at 32768 tokens. When input exceeds that, the app drops server tools, the safety check and the title request for that turn and uses the plain Anthropic-compatible path, so large attachments can use the 1M context. The first time it happens a toast explains it.',
        },
      ],
    },
    {
      id: 'memory',
      title: 'Long-term memory and graph memory',
      blocks: [
        {
          type: 'p',
          text: 'Long-term memory is a list of facts, written by you or extracted automatically and injected into system. Graph memory is a network: nodes carry a title, body and tags, and weighted edges connect them; retrieval scores keywords, tags, vectors and edge spread together.',
        },
        {
          type: 'table',
          head: ['Setting', 'Purpose'],
          rows: [
            [
              'Enable graph retrieval',
              'Injects retrieval results every turn; data is kept when off',
            ],
            [
              'Tag linking & graph expansion',
              'Links nodes that share tags (at most 3 each) and expands matches through tag neighbours; when off only vector-derived edges are used',
            ],
            ['Results to inject', 'How many nodes at most, 4 by default'],
            ['Relevance threshold', 'Nodes below the total score are skipped, 0.15 by default'],
            [
              'Vector dimension',
              'Local hash vector size, 256 by default; higher is finer but slower',
            ],
            ['Weights', 'Keyword / tag / vector / edge weights, 1 / 0.5 / 0.8 / 0.4 by default'],
            [
              'Node filter',
              'The search box above the node list filters by title / body / tags (Unicode-aware, so Cyrillic works too); tag buttons can be multi-selected and intersect with the keyword; the graph dims nodes that do not match',
            ],
            [
              'Inline editing',
              'Every node card has an edit button to change its title, body and tags in place; tag changes rebuild tag edges and the list plus graph update immediately',
            ],
          ],
        },
        {
          type: 'note',
          text: 'Memory is retrieved and injected on every message, including the first message of a new chat (that turn also generates the chat title). The block tells the model to use these facts directly instead of claiming not to know or asking you to repeat them.',
        },
        {
          type: 'p',
          text: 'Search debug runs the same pipeline once and lists each candidate: keyword, tag, vector, edge, total and whether it passed. The line above shows node and edge counts, query tokens and the top score, plus "tag-expanded N" when the switch is on. Tokens are Unicode-aware: Chinese uses single characters and bigrams, Cyrillic and other scripts are kept as whole words.',
        },
        {
          type: 'p',
          text: 'Export / import memory stores a JSON archive with saved memories, nodes and edges. Vectors are not exported; they are recomputed at the current dimension after import.',
        },
      ],
    },
    {
      id: 'vms',
      title: 'Virtual machines and terminals',
      blocks: [
        {
          type: 'p',
          text: 'Four sidebar entries let you or the model run commands in the browser, implemented very differently. They follow the chat mode: VMs not enabled there are invisible to the model.',
        },
        {
          type: 'table',
          head: ['Entry', 'What it is', 'Caveats'],
          rows: [
            [
              'NanoVM Slim',
              'WASM shell with busybox-style commands; installs Lua / SQLite / esbuild / make / PyBot toolchains on demand; virtual network (vm serve)',
              'Light and fast; smaller command set than a real Linux',
            ],
            [
              'WebVM',
              'x86 Debian 10 on CheerpX with gcc / Python / Node / git',
              'Needs cross-origin isolation; not available inside the Android WebView APK',
            ],
            [
              'Unkernel Linux',
              'A real Linux 7.x kernel compiled to WebAssembly with Alpine / Debian: desktop, windows, dock and app launcher, 80+ ready-made apps (games, browsers, media, desktop, graphics, AI, language runtimes, servers, Linux tools)',
              'Needs JSPI; workspace mounted at /mnt/workspace; disk can be grown or reset in Settings; apps download files and install packages on first run',
            ],
            [
              'DSH go',
              'A 24 MiB static Go binary in the launcher with a Chinese REPL and bash',
              'Runs inside Unkernel; download it first',
            ],
          ],
        },
        {
          type: 'ul',
          items: [
            'Virtual network: run `vm serve` inside NanoVM / WebVM; curl to 127.0.0.1 is routed into the VM.',
            'Unkernel networking uses Wisp proxies (public by default, custom wss:// allowed); apk, apt, curl and plain HTTP all go through the same proxy.',
            'The session list pins chats one by one (pinned chats move into a “Pinned” group), and “Select” in the “…” menu pins or deletes several chats at once.',
            '“Restore default settings” resets every store (settings, prompt presets, local-model preferences, NanoVM / WebVM / Unkernel parameters) and keeps the API key, chats, attachments, workspace, memory bank and statistics.',
            'The data disk is a sparse image in IndexedDB, 8 GiB by default and growable to 16 / 32 GiB; Reset data disk wipes the guest. The host passes `datasize` (GiB), `net`, `sound`, `display`, `data`, `worker`, `cpus` and `wisp` as URL parameters, plus a fixed `routes=0` so the guest’s plain HTTP also goes through Wisp instead of the unkernel CORS mirror (otherwise apt inside Debian gets a 403). Kernel memory, GPU and similar machine options belong to the VM page’s own Settings: no `mem` is sent, so page-side changes survive restarts.',
            'The app launcher carries 80+ apps: AI (Claude Code, Ollama, llama.cpp, fx, DSH go), tools, runtimes, servers, Linux, browsers, desktop, games, media and graphics; a first run downloads its files and installs packages with apk / apt, with progress in an installer window of its own.',
            'The desktop has windows, a dock, a control center, a preview browser and Wayland windows; more than one CPU needs cross-origin isolation (the host registers `coi-sw.js`), a single CPU does not.',
          ],
        },
        {
          type: 'code',
          text:
            '# start a local server inside a VM; the host curl is routed into it\n' +
            'vm serve 3000\n' +
            'curl http://127.0.0.1:3000/\n' +
            '\n' +
            '# Unkernel: inspect the workspace and the system\n' +
            'ls /mnt/workspace\n' +
            'fastfetch',
        },
      ],
    },
    {
      id: 'local-models',
      title: 'Local models',
      blocks: [
        {
          type: 'p',
          text: 'Two options: WebLLM running in the browser on WebGPU, and a self-hosted MLC-LLM REST server. Weights are cached locally and you can switch models from the composer; local tokens are not billed, but capability and context size depend on the model.',
        },
        {
          type: 'ul',
          items: [
            'Local models only support Chat only; search and text attachments are handled by the page and folded into system.',
            'Android WebView has no WebGPU, so the APK can only use the MLC-LLM API.',
            'Context window and sampling are configured on the Local models page, independent of cloud models.',
          ],
        },
      ],
    },
    {
      id: 'agent',
      title: 'Agent tools and the lab',
      blocks: [
        {
          type: 'p',
          text: 'The model can request tools (read a page, write workspace files, run VM commands); the client runs them and sends results back for a limited number of rounds. The tool list is filtered before every request by chat mode, browser-tool switches and VM switches, so the model never sees tools you disabled.',
        },
        {
          type: 'table',
          head: ['Browser tool', 'Purpose', 'Risk'],
          rows: [
            ['get_datetime', 'Current date, time and time zone', 'read-only'],
            [
              'get_location',
              'City from the configured location or browser geolocation',
              'read-only',
            ],
            ['get_weather', 'Weather lookup (network)', 'network'],
            ['send_notification', 'System notification, needs permission', 'write · confirm'],
            ['read_clipboard', 'Read the clipboard', 'write · confirm'],
            ['write_clipboard', 'Write the clipboard', 'write'],
            ['fetch_webpage', 'Fetch a page body', 'network'],
            ['create_file', 'Generate a file download / workspace entry', 'write · confirm'],
            ['open_url', 'Open a link in the browser', 'write'],
            ['show_widget', 'Render an inline widget (sandboxed iframe)', 'read-only'],
            [
              'show_genui',
              'Declare a native interface in JSON: stats, tables, charts, progress, callouts',
              'read-only',
            ],
            [
              'custom_injection',
              'Custom injection tool: the model writes its answer body into an argument you define, and the client restores it as text',
              'read-only',
            ],
          ],
        },
        {
          type: 'p',
          text: 'The prompt injection tool (bottom of Settings → Browser tools) is the only tool whose arguments you define: you pick the tool name, description and argument name, and the description must state that the answer body goes into that argument. With forced tool choice the request sets tool_choice to it, so the model can only answer as a single tool call; the client then restores the argument as plain text, so the reply card, copy and history all look like a normal answer, and nothing is actually executed.',
        },
        {
          type: 'ul',
          items: [
            'History conversion: assistant messages become tool_use by rule (only ones from this tool / every answer / never) and the user message right after becomes its tool_result (optionally only marked messages), so multi-turn context matches this round.',
            'Protocol detail: tool_use and tool_result must be adjacent and paired, so reminders for those rounds move before the question; a question with attachments puts tool_result ahead of the file blocks.',
            'API limits: tool_choice cannot coexist with thinking, the safety check field, server tools or a title request, so forced mode turns thinking off, skips the title and drops those fields for the round.',
            'When the tool is disabled or large input strips the extension fields, history is not converted, so no undeclared tool is sent.',
            'It executes nothing — it is only an output channel — so it ignores the chat-mode tool groups: it works in chat-only mode while every other browser tool stays off.',
          ],
        },
        {
          type: 'p',
          text: 'VM tools are added by mode: NanoVM exposes shell / ls / install / import, WebVM exposes shell / ls / status, and Unkernel exposes ten tools (shell, read/write files, workspace transfer, Python, info, open, restart, status). Batched and concurrent calls are only allowed in PTC and Creator.',
        },
        {
          type: 'ul',
          items: [
            'Lab: connects to a local easyjailbreak-mcp backend and runs EasyJailbreak attackers; results can be exported or imported into chat.',
            'Race: send one question through several prompt combos in parallel and keep the best score; variant race rewrites the question first.',
            'Workspace: a virtual file library shared with VMs and the model, importable / exportable as a zip in Settings.',
          ],
        },
      ],
    },
    {
      id: 'stats',
      title: 'Stats, billing and reminders',
      blocks: [
        {
          type: 'p',
          text: 'After each turn the app records server-reported usage (input, output, cache hits, search and parsed pages) and estimates cost and speed. Prices follow the official peak (weekdays 9–12 and 14–18 Beijing time) and off-peak rates; estimates are not the invoice.',
        },
        {
          type: 'ul',
          items: [
            'Session stats: rounds, steps, first token, output speed, cache hits.',
            'Usage ledger: per day and per model; the charts and heatmap read from it.',
            'Daily limits: warn when tokens or cost exceed your threshold; local models are excluded.',
            'Context management: auto-compression triggers at 80% of the window and replaces compressed history with a summary.',
          ],
        },
      ],
    },
    {
      id: 'data',
      title: 'Data management',
      blocks: [
        {
          type: 'p',
          text: 'Data management handles the API key, import, export, resetting settings and deleting all chats. Import replaces existing chats and attachments after a confirmation, and shows progress by chat (processed x / y chats and percentage); a chat’s attachments are read together with it, so images no longer need to sit after the index.',
        },
        {
          type: 'ul',
          items: [
            'Export produces a ZIP with chats, message trees and local images; the API key is not included.',
            'Import accepts ZIPs exported from DeepSeek and this project, and can be retried after interruption.',
            'Reset settings only resets preferences; chats, attachments and memories stay.',
            'Delete all chats is irreversible and also removes local attachments only they referenced.',
          ],
        },
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy and security',
      blocks: [
        {
          type: 'ul',
          items: [
            'Chats, attachments and memories live in IndexedDB and localStorage; there is no backend.',
            'The API key stays on this device and is not part of exports.',
            'Only model requests, file uploads and (if enabled) web search leave the browser, all to DeepSeek.',
            'VM networking goes through Wisp proxies; guest files stay in the browser unless you export them.',
            'No analytics or telemetry is bundled.',
          ],
        },
      ],
    },
    {
      id: 'platforms',
      title: 'Web, mobile and APK',
      blocks: [
        {
          type: 'p',
          text: 'The same code runs four ways: desktop browser, mobile browser, Android APK (WebView shell) and an offline static bundle. Differences come from browser capabilities, not from separate builds.',
        },
        {
          type: 'table',
          head: ['Platform', 'Differences'],
          rows: [
            [
              'Desktop browser',
              'Everything: WebGPU local models, WebVM, Unkernel with JSPI, cross-origin isolation and multi-CPU VMs',
            ],
            [
              'Mobile browser',
              'Drawer sidebar and bottom sheets; WebGPU depends on the browser, WebVM needs cross-origin isolation, Unkernel usually runs with one CPU',
            ],
            [
              'Android APK',
              'No WebGPU and no cross-origin isolation: WebLLM and WebVM do not work, Unkernel is single-CPU; chat, attachments, memory, NanoVM and docs all work',
            ],
            [
              'Offline bundle',
              'Same as the web build, but search and uploads still need a network',
            ],
          ],
        },
        {
          type: 'ul',
          items: [
            'Docs on a phone: the table of contents collapses into a top toggle, the article is single-column, tables scroll horizontally, and an "↑ Contents" button appears after the first screen.',
            'APK data lives in its WebView; uninstalling deletes chats and attachments, so export important data first.',
            'The web and APK stores are separate; use export / import to move chats between them.',
            'Installing a new APK over the old one keeps data; the web build updates on refresh.',
          ],
        },
      ],
    },
    {
      id: 'limits',
      title: 'Known limits',
      blocks: [
        {
          type: 'ul',
          items: [
            'Server context is 1,048,576 tokens; longer requests fail.',
            'Requests with DeepSeek extension fields cap user input at 32768 tokens; the app drops those fields for large inputs.',
            'Android WebView has no WebGPU and no cross-origin isolation, so in-browser WebLLM and WebVM do not work in the APK.',
            'Unkernel needs JSPI; older browsers show a boot error. The new page is about 127 MB and its 80+ apps download files and install packages on first run; DSH go ships with the page and needs no download.',
            'apt and the guest’s plain HTTP go through the public Wisp proxies (the page always passes `routes=0`): no more upstream 403, but they use the proxy’s bandwidth, and apps that need the unkernel mirror may stop at the installer.',
            'Forced `tool_choice` in the prompt-injection tool means no web search and no server-generated title that round: the API treats `tool_choice` as incompatible with thinking, `safety_check`, server tools and `title`.',
            '`latest_reminder` must be exactly five parts, with no comma or newline inside a field, and is followed immediately by a `user` message; the app sanitises the fields and merges summaries, and folds commas in a custom location to spaces.',
            'Jailbreak switches depend on current server policy and may stop working at any time; read the raw error first.',
            'Large attachments are re-counted every turn, so long chats get noticeably more expensive.',
          ],
        },
        {
          type: 'p',
          text: 'More details are in the [known limits document](https://github.com/xiaohuangbo/chat-demo-unrestricted/blob/main/docs/en/10-known-limits.md).',
        },
      ],
    },
    {
      id: 'faq',
      title: 'FAQ',
      blocks: [
        {
          type: 'table',
          head: ['Problem', 'Cause and fix'],
          rows: [
            [
              'Sending an attachment fails with "user input too long, N tokens exceeds max 32768 tokens"',
              'Requests carrying DeepSeek extension fields cap user input at 32768 tokens; this build drops those fields and retries for large inputs. If it still fails, check the 1M context limit.',
            ],
            [
              'WebVM does not start on mobile / in the APK',
              'WebView lacks cross-origin isolation (SharedArrayBuffer). Use NanoVM Slim or Unkernel (needs JSPI), or a desktop Chrome.',
            ],
            [
              'WebLLM is unavailable in the APK',
              'WebView has no WebGPU; use the MLC-LLM API or a cloud model in the APK.',
            ],
            [
              'Graph memory always retrieves nothing',
              'Check that graph retrieval is enabled and look at the query token count in search debug; weights and threshold both affect injection. Chinese uses characters plus bigrams, other scripts whole words.',
            ],
            [
              'History import fails',
              'The archive must be a DeepSeek export ZIP or one produced here; old, truncated or modified files are rejected with BackupError.',
            ],
            [
              'Jailbreak switches have no effect',
              'Server policy changes at any time; check whether the reply is a refusal or hits the keyword gate, then try another preset, combo or perturbation.',
            ],
            [
              'Large attachments get expensive',
              'Attachments are counted again on every turn; compress history, start a new chat or rely on memory retrieval instead.',
            ],
            [
              'An Unkernel app stops at the installer on first launch',
              'A first run downloads files and installs packages from distro mirrors (tens to hundreds of MB for Steam, Zed and friends); with no network or a blocked Wisp it waits there. Change the Wisp server in the page settings, or start DSH go first, which ships with the page.',
            ],
            [
              'The page stays on the loading animation',
              'The boot page only shows while the bundle downloads and renders: a 404 or offline bundle turns it into the raw error plus a Reload button, and a slow network shows a reload hint after 12 seconds; normally it fades out as soon as the interface renders.',
            ],
            [
              'The injection tool round had no web search or title',
              'Forced `tool_choice` is incompatible with deep thinking, `safety_check`, server tools and `title`, and the API rejects the combination as thinking mode; that round turns thinking off and drops those fields by design.',
            ],
          ],
        },
      ],
    },
    {
      id: 'glossary',
      title: 'Glossary',
      blocks: [
        {
          type: 'table',
          head: ['Term', 'Meaning'],
          rows: [
            [
              'Harness',
              'The prompt and tool orchestration layer: system, latest_reminder, tool definitions and tool round trips',
            ],
            ['DSH', 'Short for DeepSeek Harness; this project follows its request shape'],
            ['PTC', 'A mode on top of Web Agent that adds VMs and batched tool calls'],
            ['WebLLM', 'Runs model weights in the browser on WebGPU'],
            ['MLC-LLM', 'A self-hosted MLC inference server called over REST'],
            ['Files API', 'DeepSeek file upload API; attachments are referenced by file_id'],
            [
              'MCP',
              'Model Context Protocol; the lab uses it to reach a local easyjailbreak backend',
            ],
            ['Wisp', 'The WebSocket proxy protocol used by Unkernel networking'],
            [
              '9p',
              'The file-sharing protocol between Unkernel and the chat workspace, mounted at /mnt/workspace',
            ],
            ['JSPI', 'JavaScript Promise Integration, required to run the Unkernel kernel'],
            ['COI', 'Cross-Origin Isolation, required for SharedArrayBuffer and therefore WebVM'],
            [
              'Vector dimension',
              'Length of the local hash vector; affects retrieval granularity, not an embedding model',
            ],
            [
              'Edge spread',
              'Passing a share of a seed score to neighbours along edges during retrieval',
            ],
            [
              'Tag expansion',
              'Pulling tag neighbours into the candidates; active when tag linking is on',
            ],
            ['user_data', 'One Files API upload purpose, used for text and code files'],
            ['logits', 'Raw per-token scores from the model before softmax'],
            [
              'Greedy decoding',
              'Always taking the most likely token; temperature 0 approximates it',
            ],
            [
              'Nucleus (top-p) sampling',
              'Sampling from the smallest set whose cumulative probability reaches P',
            ],
            [
              'stop_reason',
              'Why a reply ended: end_turn / max_tokens / refusal / tool_use and so on',
            ],
            ['SSE', 'Server-Sent Events, the HTTP protocol used for streaming'],
            [
              'Prefix cache (cache hit)',
              'The server reuses repeated prefixes and bills the hits cheaper',
            ],
            [
              'Context window',
              'Total tokens one request may hold; 1,048,576 for the current models',
            ],
            [
              'Input / output tokens',
              'Prompt tokens (history and attachments) and generated tokens',
            ],
            [
              'Hash vector',
              'A deterministic vector from hashed tokens, not a trained semantic embedding',
            ],
            [
              'Cosine similarity',
              'Cosine of the angle between two vectors, a direction-similarity score',
            ],
            ['Relevance threshold', 'Memories scoring below it are not injected; 0.15 by default'],
            [
              'Retrieval weights',
              'Coefficients for keyword / tag / vector / edge in the total score',
            ],
          ],
        },
      ],
    },
  ],
}

export const docsFor = (locale: string): DocsDoc => (locale === 'en-US' ? en : zh)
