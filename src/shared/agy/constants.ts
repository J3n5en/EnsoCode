/** 内置 provider id。设置页、模型目录和 worker 注册用同一个值。 */
export const AGY_PROVIDER_ID = 'agy-cli';
/** pi `api` 字段。streamSimple 按它识别，不走 HTTP。 */
export const AGY_API_ID = 'agy-acp';
/** 不向 agy 发 `session/set_config_option` 的模型 id。 */
export const AGY_DEFAULT_MODEL_ID = 'default';
/** `default` 项的展示名：不设模型、由 agy 自选。不复用 provider 名，免得看着像另一个模型。模型名不走 i18n。 */
export const AGY_DEFAULT_MODEL_NAME = '默认';
export const AGY_MIN_VERSION = '1.5.1';
/** pi 把字面 apiKey 当成已配置。agy 自己的登录不进 auth.json。 */
export const AGY_PLACEHOLDER_API_KEY = 'agy-cli';
export const AGY_PROVIDER_NAME = 'agy cli';
export const AGY_PROBE_TIMEOUT_MS = 15_000;

export const SIGNED_OUT_NO_BROWSER = 'No browser is available here';
