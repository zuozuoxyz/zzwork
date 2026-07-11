import keytar from 'keytar'
import { settingsRepo } from '../db/repositories/settings.repo'

const SERVICE_NAME = 'zzwork'
const ACCOUNT_NAME = 'anthropic-api-key'

export async function getApiKey(): Promise<string | null> {
  try {
    const key = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
    if (key) return key
  } catch { /* keytar unavailable */ }

  // Fallback: read from SQLite (less secure but works everywhere)
  const fallback = settingsRepo.get('anthropic_api_key_fallback')
  return fallback || null
}

export async function setApiKey(key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, key)
  } catch {
    // Fallback: store in SQLite when keychain is unavailable
    settingsRepo.set('anthropic_api_key_fallback', key)
    return
  }
}

export async function deleteApiKey(): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    // ignore
  }
}
