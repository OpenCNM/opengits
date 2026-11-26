import { defineRoute, ok } from '@/lib/api/server/define-route';
import {
  listUserPublications,
  type RelayParticipant,
  type UserPublicationItem,
} from '@/lib/review/user-publications';

export const dynamic = 'force-dynamic';

export type { RelayParticipant, UserPublicationItem };

export const GET = defineRoute({
  scope: 'GET /api/user/publications',
  auth: 'user',
  handler: async ({ userId }) => {
    const publications = await listUserPublications(userId);
    return ok({ publications });
  },
});
