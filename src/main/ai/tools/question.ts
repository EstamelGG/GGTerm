import { z } from 'zod'
import { defineTool } from './shared'
import { questions } from '../questions'
export const questionParameters = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        description: z.string().trim().max(300).optional()
      })
    )
    .min(1)
    .max(3)
})
export const questionTools = [
  defineTool('ask_user', {
    description:
      'Ask the user to clarify an ambiguous goal or a material decision you cannot infer. Supply 1–3 distinct options in the user’s language; the UI automatically adds Other with free text. Do not include Other yourself. This call waits for the user, then returns their answer. Never use for secrets or repeat questions already answered. If cancelled, do not assume approval or ask again automatically. Make progress independently when possible; avoid trivial questions.',
    parameters: questionParameters,
    handler: async (input, invocation) =>
      questions.ask(
        {
          ...questionParameters.parse(input),
          sessionId: invocation.sessionId,
          toolCallId: invocation.toolCallId
        },
        invocation.signal
      )
  })
]
