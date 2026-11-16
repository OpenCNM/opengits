import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';

export class WorkingMemoryManager {
 /**
 * Save a message to the database and estimate its tokens.
 */
 static async saveMessage(
 userId: string,
 sessionId: string,
 role: 'user' | 'assistant' | 'system' | 'tool',
 content: string,
 toolInvocations?: any,
 extraUsage?: {
   promptTokens?: number;
   completionTokens?: number;
   model?: string;
 }
 ) {
 const promptTokens = extraUsage?.promptTokens || 0;
 const completionTokens = extraUsage?.completionTokens || 0;
 const exactTotal = promptTokens + completionTokens;

 // Use exact total if provided, otherwise fallback to lightweight estimation
 const estimatedTokens = exactTotal > 0 ? exactTotal : Math.ceil(content.length / 3);

 return await prisma.conversationMessage.create({
 data: {
 userId,
 conversationId: sessionId,
 role,
 content,
 tokens: estimatedTokens,
 promptTokens,
 completionTokens,
 model: extraUsage?.model,
 toolInvocations: toolInvocations ? structuredClone(toolInvocations) : undefined,
 },
 });
 }

 /**
 * Get the context window for a session, strictly limited by maxTokens.
 * Employs a sliding window approach, dropping oldest messages if budget is exceeded.
 */
 static async getContextWindow(
 sessionId: string,
 maxTokens: number = 4000
 ) {
 // 1. Fetch recent messages (e.g., last 50) ordered by newest first to ensure we keep latest
 const recentMessages = await prisma.conversationMessage.findMany({
 where: { conversationId: sessionId },
 orderBy: { createdAt: 'desc' },
 take: ENGINE_CONFIG.pagination.workingMemoryLimit,
 select: {
 role: true,
 content: true,
 tokens: true,
 },
 });

 const selectedMessages = [];
 let currentTokens = 0;

 // 2. Accumulate messages until we hit the budget
 for (let i = 0; i < recentMessages.length; i++) {
 const msg = recentMessages[i];
 if (currentTokens + msg.tokens > maxTokens) {
 if (i === 0) {
 // Guarantee at least the first (newest) message is included to prevent LLM from losing the user query
 selectedMessages.push({
 role: msg.role as 'user' | 'assistant' | 'system',
 content: msg.content.substring(0, maxTokens * 3), // heuristic truncation
 });
 }
 break; // Stop adding older messages once budget is reached
 }
 currentTokens += msg.tokens;
 selectedMessages.push({
 role: msg.role as 'user' | 'assistant' | 'system',
 content: msg.content,
 });
 }

 // 3. Reverse to chronological order for the LLM
 return selectedMessages.reverse();
 }
}
