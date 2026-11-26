import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';

export class WorkingMemoryManager {
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

 static async getContextWindow(
 sessionId: string,
 maxTokens: number = 4000
 ) {
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

 for (let i = 0; i < recentMessages.length; i++) {
 const msg = recentMessages[i];
 if (currentTokens + msg.tokens > maxTokens) {
 if (i === 0) {
 // Always keep the newest message even if it exceeds maxTokens so the active user query is never dropped.
 selectedMessages.push({
 role: msg.role as 'user' | 'assistant' | 'system',
 content: msg.content.substring(0, maxTokens * 3),
 });
 }
 break;
 }
 currentTokens += msg.tokens;
 selectedMessages.push({
 role: msg.role as 'user' | 'assistant' | 'system',
 content: msg.content,
 });
 }

 return selectedMessages.reverse();
 }
}
