import keytar from 'keytar'

const SERVICE_NAME = 'zzwork'
const ACCOUNT_NAME = 'anthropic-api-key'

export async function getApiKey(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    // keytar may not be available on all Linux configs
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, key)
  } catch {
    throw new Error('无法存储 API Key，请检查系统密钥链是否可用')
  }
}

export async function deleteApiKey(): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    // ignore
  }
}
