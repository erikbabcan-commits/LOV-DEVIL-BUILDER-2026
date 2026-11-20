import type { ModelEntry, ProviderRegistry } from './registry';
import { cascadeFor, route as smartRoute, type RouteMode, type RouteReason } from './smartRouter';

/** Model choice for one generation run, reported to the client as `route`. */
export interface GenerationRoute {
  entries: ModelEntry[];
  decision: { model: string; reason: RouteReason };
}

export interface GenerationRouteInput {
  modelId?: string;
  allowFallback?: boolean;
  fallbackIds?: readonly string[];
  prompt: string;
  mode: 'create' | 'iterate' | 'fix' | 'explain' | 'auto';
  fileCount: number;
}

function routeMode(mode: GenerationRouteInput['mode']): RouteMode {
  if (mode === 'fix') return 'fix';
  if (mode === 'explain') return 'explain';
  return 'generate';
}

/**
 * Picks the provider chain for /api/agent/generate and the durable worker (wave-3 glue).
 * 1. An explicit `modelId` always wins: exactly today's `providers.route(...)`, UI fallbacks included.
 * 2. Without one, the smart router (agent 8) picks a model by rules.
 * 3. If that model is the registry default, today's path is kept unchanged (same fallbacks).
 *    Otherwise the router's cascade (max 3, only registered models) replaces it.
 * Throws `invalid_model` exactly like `providers.route` for an unknown model or bad fallbacks.
 */
export function selectGenerationRoute(providers: ProviderRegistry, input: GenerationRouteInput): GenerationRoute {
  const current = providers.route(input.modelId, input.allowFallback, input.fallbackIds);
  if (input.modelId !== undefined) {
    return { entries: current, decision: { model: input.modelId, reason: 'explicit_user_choice' } };
  }

  const available = providers.ids();
  const decision = smartRoute(input.prompt, routeMode(input.mode), { fileCount: input.fileCount, availableModels: available });
  if (decision.model === current[0].id) {
    return { entries: current, decision: { model: decision.model, reason: decision.reason } };
  }

  const entries = cascadeFor(decision.model, available)
    .map(id => providers.find(id))
    .filter((entry): entry is ModelEntry => entry !== undefined);
  if (!entries.length) throw new Error('invalid_model');
  return { entries, decision: { model: decision.model, reason: decision.reason } };
}

/** Adds the routing decision to the `run_started` event; every other event passes unchanged. */
export function withRouteDecision<E extends { type: string }>(event: E, decision: GenerationRoute['decision']): E {
  return event.type === 'run_started' ? { ...event, route: { model: decision.model, reason: decision.reason } } : event;
}
