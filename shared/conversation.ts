import {z} from 'zod';
/** Plain transcript only: never provider credentials, raw generated code or UI state. */
export const ConversationTurnSchema=z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(4000)}).strict();
export const ConversationSchema=ConversationTurnSchema.array().max(512);
export type ConversationTurn=z.infer<typeof ConversationTurnSchema>;
