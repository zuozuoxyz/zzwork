import keytar from 'keytar'
import { settingsRepo } from '../db/repositories/settings.repo'

const SERVICE_NAME = 'zzwork'
const KEY_PREFIX = 'model:'

function keyName(modelId: string): string {
  return `${KEY_PREFIX}${modelId}`
}

export async function getModelKey(modelId: string): Promise<string | null> {
  try {
    const key = await keytar.getPassword(SERVICE_NAME, keyName(modelId))
    if (key) return key
  } catch { /* keytar unavailable */ }
  // SQLite fallback (encrypted at rest by app in future Phase)
  const fallback = settingsRepo.get(`model_key_${modelId}`)
  return fallback || null
}

export async function setModelKey(modelId: string, key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, keyName(modelId), key)
  } catch {
    // Fallback to SQLite when keychain unavailable
    settingsRepo.set(`model_key_${modelId}`, key)
  }
}

export async function deleteModelKey(modelId: string): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE_NAME, keyName(modelId))
  } catch { /* ignore */ }
  settingsRepo.set(`model_key_${modelId}`, '')
}
