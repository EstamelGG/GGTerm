export interface AgentQuestion {
  sessionId: string
  toolCallId: string
  question: string
  options: { label: string; description?: string }[]
}
export type AgentQuestionAnswer =
  { outcome: 'answered'; answer: string; optionIndex: number | null } | { outcome: 'cancelled' }
