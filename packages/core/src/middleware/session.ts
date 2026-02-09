import { FastifyInstance, FastifyRequest } from "fastify";

export interface SessionContext {
  sessionId: string;
  conversationId: string;
  requestId: string;
  startTime: number;
}

declare module "fastify" {
  interface FastifyRequest {
    sessionContext: SessionContext;
  }
}

function generateId(): string {
  // Simple ID generation - timestamp + random
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export async function sessionMiddleware(fastify: FastifyInstance) {
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    // Extract from headers if client provides them
    const sessionId =
      (request.headers["x-session-id"] as string) ||
      (request.headers["session-id"] as string) ||
      generateId();
    const conversationId =
      (request.headers["x-conversation-id"] as string) ||
      (request.headers["conversation-id"] as string) ||
      generateId();

    request.sessionContext = {
      sessionId,
      conversationId,
      requestId: generateId(),
      startTime: Date.now(),
    };

    // Also set on the request object for backward compatibility
    (request as any).sessionId = sessionId;
    (request as any).requestId = request.sessionContext.requestId;
  });
}

export function getSessionContext(
  request: FastifyRequest,
): SessionContext | undefined {
  return request.sessionContext;
}

export function setSessionContext(
  request: FastifyRequest,
  context: Partial<SessionContext>,
): void {
  if (!request.sessionContext) {
    request.sessionContext = {
      sessionId: context.sessionId || generateId(),
      conversationId: context.conversationId || generateId(),
      requestId: context.requestId || generateId(),
      startTime: context.startTime || Date.now(),
    };
  } else {
    Object.assign(request.sessionContext, context);
  }
}

export default sessionMiddleware;
