import { useCallback } from 'react'
import Editor, { type OnChange, type OnMount } from '@monaco-editor/react'
import { useEditorStore } from '../../stores/editor.store'
import type { editor } from 'monaco-editor'

export default function MonacoEditorWrapper(): JSX.Element {
  const fileContent = useEditorStore((s) => s.fileContent)
  const setFileContent = useEditorStore((s) => s.setFileContent)
  const markDirty = useEditorStore((s) => s.markDirty)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const activeTab = useEditorStore((s) => s.openTabs.find((t) => t.id === s.activeTabId))

  const handleChange: OnChange = useCallback((value) => {
    if (value !== undefined) {
      setFileContent(value)
      if (activeTabId) {
        markDirty(activeTabId)
      }
    }
  }, [setFileContent, markDirty, activeTabId])

  const handleMount: OnMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    // Auto-focus the editor
    editor.focus()
  }, [])

  if (!activeTab) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
        fontSize: 14,
        userSelect: 'none',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📝</div>
          <div>选择一个文件开始编辑</div>
          <div style={{ fontSize: 12, marginTop: 8, color: '#555' }}>
            Ctrl+O 打开文件
          </div>
        </div>
      </div>
    )
  }

  return (
    <Editor
      height="100%"
      defaultLanguage="markdown"
      language={getLanguage(activeTab.path)}
      value={fileContent}
      onChange={handleChange}
      onMount={handleMount}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 16 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
      }}
    />
  )
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    md: 'markdown',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    sql: 'sql',
    css: 'css',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
  }
  return map[ext ?? ''] ?? 'plaintext'
}
