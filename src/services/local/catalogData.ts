/**
 * WebLLM 预置模型目录：名称、厂商、家族与推荐采样参数。
 * 数据移植自 mlc-ai/web-llm-chat（Apache-2.0）的 DEFAULT_MODEL_BASES，
 * 运行时与 @mlc-ai/web-llm 的 prebuiltAppConfig 求交集，未被当前版本支持的条目自动丢弃。
 */
export type LocalModelBase = {
  /** WebLLM 的 model_id */
  name: string
  display_name: string
  provider?: string
  family: LocalModelFamily
  recommended_config?: {
    temperature?: number
    context_window_size?: number
    top_p?: number
    presence_penalty?: number
    frequency_penalty?: number
  }
}

/** 模型家族：用于分组与图标配色 */
export type LocalModelFamily =
  | 'llama'
  | 'phi'
  | 'mistral'
  | 'gemma'
  | 'qwen'
  | 'smollm'
  | 'wizardmath'
  | 'stablelm'
  | 'redpajama'
  | 'deepseek'
  | 'olmo'
  | 'other'

const MODEL_BASE_LIST: LocalModelBase[] = [
  // Phi-3.5 Vision
  {
    name: 'Phi-3.5-vision-instruct-q4f32_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3.5-vision-instruct-q4f16_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Llama-3.2
  {
    name: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.2-1B-Instruct-q0f32-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.2-1B-Instruct-q0f16-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  // Llama-3.1 8B
  {
    name: 'Llama-3.1-8B-Instruct-q4f32_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.1-8B-Instruct-q4f16_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  // Deepseek
  {
    name: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC',
    display_name: 'DeepSeek',
    provider: 'DeepSeek',
    family: 'deepseek',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC',
    display_name: 'DeepSeek',
    provider: 'DeepSeek',
    family: 'deepseek',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'DeepSeek-R1-Distill-Llama-8B-q4f32_1-MLC',
    display_name: 'DeepSeek',
    provider: 'DeepSeek',
    family: 'deepseek',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC',
    display_name: 'DeepSeek',
    provider: 'DeepSeek',
    family: 'deepseek',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Hermes
  {
    name: 'Hermes-3-Llama-3.2-3B-q4f32_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'mistral',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  {
    name: 'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC',
    display_name: 'Hermes',
    provider: 'NousResearch',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Phi
  {
    name: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3.5-mini-instruct-q4f32_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3.5-mini-instruct-q4f16_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3.5-mini-instruct-q4f32_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Mistral
  {
    name: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC',
    display_name: 'Mistral',
    provider: 'Mistral AI',
    family: 'mistral',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Mistral-7B-Instruct-v0.3-q4f32_1-MLC',
    display_name: 'Mistral',
    provider: 'Mistral AI',
    family: 'mistral',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Mistral-7B-Instruct-v0.2-q4f16_1-MLC',
    display_name: 'Mistral',
    provider: 'Mistral AI',
    family: 'mistral',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'OpenHermes-2.5-Mistral-7B-q4f16_1-MLC',
    display_name: 'OpenHermes',
    provider: 'NousResearch',
    family: 'mistral',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'NeuralHermes-2.5-Mistral-7B-q4f16_1-MLC',
    display_name: 'NeuralHermes',
    provider: 'Maxime Labonne',
    family: 'mistral',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  // WizardMath
  {
    name: 'WizardMath-7B-V1.1-q4f16_1-MLC',
    display_name: 'WizardMath',
    provider: 'WizardLM',
    family: 'wizardmath',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  // SmolLM2
  {
    name: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-1.7B-Instruct-q4f32_1-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-360M-Instruct-q0f16-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-360M-Instruct-q0f32-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-135M-Instruct-q0f16-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'SmolLM2-135M-Instruct-q0f32-MLC',
    display_name: 'SmolLM',
    provider: 'HuggingFaceTB',
    family: 'smollm',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Qwen3
  {
    name: 'Qwen3-0.6B-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-0.6B-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-0.6B-q0f16-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-0.6B-q0f32-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-1.7B-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-1.7B-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-4B-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-4B-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-8B-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen3-8B-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  // Qwen2.5
  {
    name: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-0.5B-Instruct-q0f16-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-0.5B-Instruct-q0f32-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-3B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-7B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  // Qwen2.5-Coder
  {
    name: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-0.5B-Instruct-q0f16-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-0.5B-Instruct-q0f32-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1.0,
    },
  },
  {
    name: 'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1.0,
    },
  },
  {
    name: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1.0,
    },
  },
  {
    name: 'Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1.0,
    },
  },
  // Qwen2-Math
  {
    name: 'Qwen2-Math-1.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-Math-1.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 1.0,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-Math-7B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-Math-7B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  // Gemma 4
  {
    name: 'gemma-4-E2B-it-q4f16_1-MLC',
    display_name: 'Gemma 4',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-4-E2B-it-q4f32_1-MLC',
    display_name: 'Gemma 4',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  // Gemma 2
  {
    name: 'gemma-2-2b-it-q4f16_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-2b-it-q4f32_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-2b-it-q4f16_1-MLC-1k',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-2b-it-q4f32_1-MLC-1k',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-9b-it-q4f16_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-9b-it-q4f32_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.95,
    },
  },
  {
    name: 'gemma-2-2b-jpn-it-q4f16_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.9,
    },
  },
  {
    name: 'gemma-2-2b-jpn-it-q4f32_1-MLC',
    display_name: 'Gemma',
    provider: 'Google',
    family: 'gemma',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 1,
      top_p: 0.9,
    },
  },
  // StableLM
  {
    name: 'stablelm-2-zephyr-1_6b-q4f16_1-MLC',
    display_name: 'StableLM',
    provider: 'Hugging Face',
    family: 'stablelm',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  {
    name: 'stablelm-2-zephyr-1_6b-q4f32_1-MLC',
    display_name: 'StableLM',
    provider: 'Hugging Face',
    family: 'stablelm',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  {
    name: 'stablelm-2-zephyr-1_6b-q4f16_1-MLC-1k',
    display_name: 'StableLM',
    provider: 'Hugging Face',
    family: 'stablelm',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  {
    name: 'stablelm-2-zephyr-1_6b-q4f32_1-MLC-1k',
    display_name: 'StableLM',
    provider: 'Hugging Face',
    family: 'stablelm',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  // RedPajama
  {
    name: 'RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC',
    display_name: 'RedPajama',
    provider: 'Together',
    family: 'redpajama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC',
    display_name: 'RedPajama',
    provider: 'Together',
    family: 'redpajama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC-1k',
    display_name: 'RedPajama',
    provider: 'Together',
    family: 'redpajama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC-1k',
    display_name: 'RedPajama',
    provider: 'Together',
    family: 'redpajama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  // TinyLlama
  {
    name: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC-1k',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC-1k',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  // Older models
  {
    name: 'Llama-3.1-70B-Instruct-q3f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Qwen2-0.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-0.5B-Instruct-q0f16-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-0.5B-Instruct-q0f32-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-1.5B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-1.5B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-7B-Instruct-q4f16_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Qwen2-7B-Instruct-q4f32_1-MLC',
    display_name: 'Qwen',
    provider: 'Alibaba',
    family: 'qwen',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.8,
    },
  },
  {
    name: 'Llama-3-8B-Instruct-q4f32_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3-8B-Instruct-q4f16_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3-8B-Instruct-q4f32_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3-8B-Instruct-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-3-70B-Instruct-q3f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 0.95,
    },
  },
  // Phi3-mini-instruct
  {
    name: 'Phi-3-mini-4k-instruct-q4f16_1-MLC',
    display_name: 'Phi 3',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3-mini-4k-instruct-q4f32_1-MLC',
    display_name: 'Phi 3',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3-mini-4k-instruct-q4f16_1-MLC-1k',
    display_name: 'Phi 3',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Phi-3-mini-4k-instruct-q4f32_1-MLC-1k',
    display_name: 'Phi 3',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
    },
  },
  {
    name: 'Llama-2-7b-chat-hf-q4f32_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-2-7b-chat-hf-q4f16_1-MLC-1k',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-2-7b-chat-hf-q4f32_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-2-7b-chat-hf-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      top_p: 0.9,
    },
  },
  {
    name: 'Llama-2-13b-chat-hf-q4f16_1-MLC',
    display_name: 'Llama',
    provider: 'Meta',
    family: 'llama',
    recommended_config: {
      temperature: 0.6,
      top_p: 0.9,
    },
  },
  {
    name: 'phi-2-q4f16_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-2-q4f32_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-2-q4f16_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-2-q4f32_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-1_5-q4f16_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-1_5-q4f32_1-MLC',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-1_5-q4f16_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'phi-1_5-q4f32_1-MLC-1k',
    display_name: 'Phi',
    provider: 'Microsoft',
    family: 'phi',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC-1k',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
  {
    name: 'TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC-1k',
    display_name: 'TinyLlama',
    provider: 'Zhang Peiyuan',
    family: 'llama',
    recommended_config: {
      temperature: 0.7,
      top_p: 0.95,
    },
  },
]

export const MODEL_BASES: readonly LocalModelBase[] = MODEL_BASE_LIST
