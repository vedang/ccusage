import path from 'node:path';
import process from 'node:process';
import { isDirectorySync } from 'path-type';
import * as v from 'valibot';
import {
	DEFAULT_PI_AGENT_PATH,
	PI_AGENT_DIR_ENV,
	PI_AGENT_SESSIONS_DIR_NAME,
	USER_HOME_DIR,
} from './_consts.ts';
import { isoTimestampSchema } from './_types.ts';

const piAgentUsageSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.optional(v.number()),
	cacheWrite: v.optional(v.number()),
	totalTokens: v.optional(v.number()),
	cost: v.optional(
		v.object({
			total: v.optional(v.number()),
		}),
	),
});

const piAgentSubagentResultSchema = v.object({
	usage: v.optional(v.record(v.string(), v.unknown())),
	model: v.optional(v.string()),
});

export const piAgentMessageSchema = v.object({
	type: v.optional(v.string()),
	timestamp: isoTimestampSchema,
	message: v.object({
		role: v.optional(v.string()),
		model: v.optional(v.string()),
		usage: v.optional(piAgentUsageSchema),
		toolName: v.optional(v.string()),
		details: v.optional(
			v.object({
				results: v.optional(v.array(piAgentSubagentResultSchema)),
			}),
		),
	}),
});

export type PiAgentMessage = v.InferOutput<typeof piAgentMessageSchema>;

type PiAgentUsage = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		total?: number;
	};
};

type PiAgentUsageEntry = {
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens: number;
		cache_read_input_tokens: number;
	};
	model: string | undefined;
	costUSD: number | undefined;
	totalTokens: number;
};

type PiAgentUsageSource = 'assistant' | 'subagent';

function createModelName(model: string, usageSource: PiAgentUsageSource): string {
	return usageSource === 'subagent' ? `[pi-subagent] ${model}` : `[pi] ${model}`;
}

function createUsageEntry(
	usage: PiAgentUsage,
	model: string | undefined,
	usageSource: PiAgentUsageSource = 'assistant',
): PiAgentUsageEntry {
	const totalTokens =
		usage.totalTokens ??
		usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

	return {
		usage: {
			input_tokens: usage.input,
			output_tokens: usage.output,
			cache_creation_input_tokens: usage.cacheWrite ?? 0,
			cache_read_input_tokens: usage.cacheRead ?? 0,
		},
		model: model != null ? createModelName(model, usageSource) : undefined,
		costUSD: usage.cost?.total,
		totalTokens,
	};
}

export function isPiAgentUsageEntry(data: PiAgentMessage): boolean {
	const isMessage = data.type == null || data.type === 'message';
	return (
		isMessage &&
		data.message?.role === 'assistant' &&
		data.message?.usage != null &&
		typeof data.message.usage.input === 'number' &&
		typeof data.message.usage.output === 'number'
	);
}

export function extractPiAgentSubagentUsageEntries(data: PiAgentMessage): PiAgentUsageEntry[] {
	const toolResults = data.message?.details?.results;
	if (data.message?.toolName !== 'subagent' || !Array.isArray(toolResults)) {
		return [];
	}

	const entries: PiAgentUsageEntry[] = [];
	for (const result of toolResults) {
		const usage = result?.usage;
		if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
			continue;
		}

		const usageRecord = usage as Record<string, unknown>;
		const input = usageRecord.input;
		const output = usageRecord.output;
		if (typeof input !== 'number' || typeof output !== 'number') {
			continue;
		}

		const cacheRead = usageRecord.cacheRead;
		const cacheWrite = usageRecord.cacheWrite;
		const totalTokens = usageRecord.totalTokens;
		const rawCost = usageRecord.cost;
		let normalizedCost: { total?: number } | undefined;
		if (rawCost != null && typeof rawCost === 'object' && !Array.isArray(rawCost)) {
			const rawCostRecord = rawCost as Record<string, unknown>;
			if (typeof rawCostRecord.total === 'number') {
				normalizedCost = {
					total: rawCostRecord.total,
				};
			}
		}

		const normalizedUsage: PiAgentUsage = {
			input,
			output,
			cacheRead: typeof cacheRead === 'number' ? cacheRead : undefined,
			cacheWrite: typeof cacheWrite === 'number' ? cacheWrite : undefined,
			totalTokens: typeof totalTokens === 'number' ? totalTokens : undefined,
			cost: normalizedCost,
		};

		entries.push(
			createUsageEntry(normalizedUsage, result.model ?? data.message?.model, 'subagent'),
		);
	}

	return entries;
}

export function transformPiAgentUsage(data: PiAgentMessage): PiAgentUsageEntry | null {
	if (isPiAgentUsageEntry(data)) {
		return createUsageEntry(data.message.usage!, data.message?.model);
	}

	return extractPiAgentSubagentUsageEntries(data)[0] ?? null;
}

export function extractPiAgentSessionId(filePath: string): string {
	const filename = path.basename(filePath, '.jsonl');
	const idx = filename.indexOf('_');
	return idx !== -1 ? filename.slice(idx + 1) : filename;
}

export function extractPiAgentProject(filePath: string): string {
	const normalizedPath = filePath.replace(/[/\\]/g, path.sep);
	const segments = normalizedPath.split(path.sep);
	const idx = segments.findIndex((s) => s === 'sessions');
	if (idx === -1 || idx + 1 >= segments.length) {
		return 'unknown';
	}
	return segments[idx + 1] ?? 'unknown';
}

export function getPiAgentPaths(customPath?: string): string[] {
	if (customPath != null && customPath !== '') {
		const resolved = path.resolve(customPath);
		if (isDirectorySync(resolved)) {
			return [resolved];
		}
	}

	const envPath = (process.env[PI_AGENT_DIR_ENV] ?? '').trim();
	if (envPath !== '') {
		const resolved = path.resolve(envPath);
		if (isDirectorySync(resolved)) {
			return [resolved];
		}
	}

	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_PI_AGENT_PATH, PI_AGENT_SESSIONS_DIR_NAME);
	if (isDirectorySync(defaultPath)) {
		return [defaultPath];
	}

	return [];
}


if (import.meta.vitest != null) {
	describe('isPiAgentUsageEntry', () => {
		it('returns true for valid assistant message with usage', () => {
			const data: PiAgentMessage = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					model: 'claude-opus-4-5',
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 20,
					},
				},
			};
			expect(isPiAgentUsageEntry(data)).toBe(true);
		});

		it('returns false for user message', () => {
			const data: PiAgentMessage = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'user',
					usage: {
						input: 100,
						output: 50,
					},
				},
			};
			expect(isPiAgentUsageEntry(data)).toBe(false);
		});

		it('returns false for non-message type', () => {
			const data: PiAgentMessage = {
				type: 'tool_use',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					usage: {
						input: 100,
						output: 50,
					},
				},
			};
			expect(isPiAgentUsageEntry(data)).toBe(false);
		});

		it('returns false when usage is missing', () => {
			const data: PiAgentMessage = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
				},
			};
			expect(isPiAgentUsageEntry(data)).toBe(false);
		});

		it('returns true when type is undefined but has assistant with usage', () => {
			const data: PiAgentMessage = {
				type: undefined,
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					model: 'claude-opus-4-5',
					usage: {
						input: 100,
						output: 50,
					},
				},
			};
			expect(isPiAgentUsageEntry(data)).toBe(true);
		});
	});

	describe('extractPiAgentSessionId', () => {
		it('extracts session ID from filename with timestamp prefix', () => {
			const filePath =
				'/path/to/sessions/project/2025-12-19T08-12-33-794Z_2c16ab69-02b4-46e1-96ad-5b19ef6be8c4.jsonl';
			expect(extractPiAgentSessionId(filePath)).toBe('2c16ab69-02b4-46e1-96ad-5b19ef6be8c4');
		});

		it('returns full filename when no underscore', () => {
			const filePath = '/path/to/sessions/project/session-id.jsonl';
			expect(extractPiAgentSessionId(filePath)).toBe('session-id');
		});
	});

	describe('extractPiAgentProject', () => {
		it('extracts project name from path', () => {
			const filePath = '/Users/test/.pi/agent/sessions/--Users-test-project--/file.jsonl';
			expect(extractPiAgentProject(filePath)).toBe('--Users-test-project--');
		});

		it('returns unknown when sessions not in path', () => {
			const filePath = '/Users/test/.pi/agent/other/project/file.jsonl';
			expect(extractPiAgentProject(filePath)).toBe('unknown');
		});
	});

	describe('transformPiAgentUsage', () => {
		it('transforms valid pi-agent usage to ccusage format', () => {
			const data: PiAgentMessage = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					model: 'claude-opus-4-5',
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 20,
						totalTokens: 180,
						cost: {
							total: 0.05,
						},
					},
				},
			};

			const result = transformPiAgentUsage(data);
			expect(result).not.toBeNull();
			expect(result?.usage.input_tokens).toBe(100);
			expect(result?.usage.output_tokens).toBe(50);
			expect(result?.usage.cache_read_input_tokens).toBe(10);
			expect(result?.usage.cache_creation_input_tokens).toBe(20);
			expect(result?.model).toBe('[pi] claude-opus-4-5');
			expect(result?.costUSD).toBe(0.05);
			expect(result?.totalTokens).toBe(180);
		});

		it('extracts usage from a single nested subagent toolResult entry', () => {
			const data = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					toolName: 'subagent',
					details: {
						results: [
							{
								model: 'claude-opus-4-5',
								usage: {
									input: 12,
									output: 4,
									cacheRead: 1,
									cacheWrite: 0,
									totalTokens: 17,
									cost: {
										total: 0.03,
									},
								},
							},
						],
					},
				},
			} as unknown as PiAgentMessage;

			const result = transformPiAgentUsage(data);
			expect(result).not.toBeNull();
			expect(result).toMatchObject({
				model: '[pi-subagent] claude-opus-4-5',
				usage: {
					input_tokens: 12,
					output_tokens: 4,
					cache_read_input_tokens: 1,
					cache_creation_input_tokens: 0,
				},
				totalTokens: 17,
				costUSD: 0.03,
			});
		});

		it('falls back to parent model when subagent result model is missing', () => {
			const data = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					model: 'parent-claude-4',
					toolName: 'subagent',
					details: {
						results: [
							{
								usage: {
									input: 3,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 4,
								},
							},
						],
					},
				},
			} as unknown as PiAgentMessage;

			const result = transformPiAgentUsage(data);
			expect(result?.model).toBe('[pi-subagent] parent-claude-4');
		});

		it('returns null when nested subagent usage is malformed', () => {
			const data = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					toolName: 'subagent',
					details: {
						results: [
							{
								usage: {
									input: 'bad',
									output: 4,
								},
							},
						],
					},
				},
			} as unknown as PiAgentMessage;

			expect(transformPiAgentUsage(data)).toBeNull();
		});

		it('calculates totalTokens when not provided', () => {
			const data: PiAgentMessage = {
				type: 'message',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
					model: 'claude-opus-4-5',
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 20,
					},
				},
			};

			const result = transformPiAgentUsage(data);
			expect(result?.totalTokens).toBe(180);
		});

		it('returns null for invalid entry', () => {
			const data: PiAgentMessage = {
				type: 'tool_use',
				timestamp: '2024-01-01T00:00:00Z' as v.InferOutput<typeof isoTimestampSchema>,
				message: {
					role: 'assistant',
				},
			};

			expect(transformPiAgentUsage(data)).toBeNull();
		});
	});
}
