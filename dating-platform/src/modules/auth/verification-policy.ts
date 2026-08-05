export type VerificationDecision = {
  email: boolean;
  phone: boolean;
  liveness: boolean;
  identity: boolean;
};

export type VerificationPolicyInput = {
  selfDeclaredCountryCode: string;
  risk: "low" | "medium" | "high";
  action: "browse" | "message" | "pay";
};

export interface VerificationPolicyProvider {
  decide(
    input: VerificationPolicyInput,
  ): VerificationDecision | Promise<VerificationDecision>;
}

export function createVerificationPolicy(provider: VerificationPolicyProvider) {
  return {
    async decide(input: VerificationPolicyInput): Promise<VerificationDecision> {
      return provider.decide(input);
    },
  };
}

export const launchVerificationPolicy = createVerificationPolicy({
  decide: decideVerification,
});

export type VerificationState = VerificationDecision;
export type VerificationRequestContext = {
  selfDeclaredCountryCode: string;
  risk: VerificationPolicyInput["risk"];
  satisfied: VerificationState;
};

export interface VerificationContextRepository {
  get(userId: string): Promise<VerificationRequestContext>;
}

type Session = { user: { id: string } };

function jsonError(code: string, status: number): Response {
  return Response.json({ error: { code } }, { status });
}

function parseAction(value: unknown): VerificationPolicyInput["action"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return null;
  return record.action === "browse" || record.action === "message" || record.action === "pay"
    ? record.action
    : null;
}

export function createVerificationPolicyHandler(input: {
  getSession(headers: Headers): Promise<Session | null>;
  contextRepository: VerificationContextRepository;
  policy?: ReturnType<typeof createVerificationPolicy>;
}) {
  return async function POST(request: Request): Promise<Response> {
    let session: Session | null;
    try {
      session = await input.getSession(request.headers);
    } catch {
      return jsonError("INTERNAL_ERROR", 500);
    }
    if (!session) return jsonError("UNAUTHORIZED", 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const action = parseAction(body);
    if (!action) return jsonError("INVALID_REQUEST", 400);

    try {
      const context = await input.contextRepository.get(session.user.id);
      const required = await (input.policy ?? launchVerificationPolicy).decide({
        selfDeclaredCountryCode: context.selfDeclaredCountryCode,
        risk: context.risk,
        action,
      });
      const missing = (Object.keys(required) as Array<keyof VerificationDecision>)
        .filter((kind) => required[kind] && !context.satisfied[kind]);
      return Response.json({ missing });
    } catch {
      return jsonError("INTERNAL_ERROR", 500);
    }
  };
}

export function decideVerification(input: VerificationPolicyInput): VerificationDecision {
  return {
    email: true,
    phone: input.action === "message" || input.risk === "high",
    liveness: input.risk === "high",
    identity: input.risk === "high" || input.action === "pay",
  };
}
