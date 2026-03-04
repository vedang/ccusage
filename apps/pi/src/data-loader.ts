import fs from 'node:fs';
import readline from 'node:readline';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	extractPiAgentProject,
	extractPiAgentSessionId,
	extractPiAgentSubagentUsageEntries,
	getPiAgentPaths,
	isPiAgentUsageEntry,
	piAgentMessageSchema,
	transformPiAgentUsage,
} from './_pi-agent.ts';

export type Source = 'claude-code' | 'pi-agent';

export type LoadOptions = {
	piPath?: string;
	since?: string;
	until?: string;
	timezone?: string;
	order?: 'asc' | 'desc';
};

export type DailyUsageWithSource = {
	date: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

export type SessionUsageWithSource = {
	sessionId: string;
	projectPath: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	lastActivity: string;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

export type MonthlyUsageWithSource = {
	month: string;
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>;
};

async function processJSONLFileByLine(
	filePath: string,
	processor: (line: string, lineIndex: number) => Promise<void> | void,
): Promise<void> {
	const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	let lineIndex = 0;
	for await (const line of rl) {
		const trimmedLine = line.trim();
		if (trimmedLine !== '') {
			await processor(trimmedLine, lineIndex);
		}
		lineIndex += 1;
	}
}

async function globPiAgentFiles(paths: string[]): Promise<string[]> {
	const allFiles: string[] = [];
	for (const basePath of paths) {
		const files = await glob(['**/*.jsonl'], {
			cwd: basePath,
			absolute: true,
		});
		allFiles.push(...files);
	}
	return allFiles;
}

function formatDate(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	return date.toLocaleDateString('en-CA', { timeZone: tz });
}

function formatMonth(timestamp: string, timezone?: string): string {
	const date = new Date(timestamp);
	const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const formatted = date.toLocaleDateString('en-CA', { timeZone: tz });
	return formatted.slice(0, 7);
}

function normalizeDate(value: string): string {
	return value.replace(/-/g, '');
}

function isInDateRange(date: string, since?: string, until?: string): boolean {
	const dateKey = normalizeDate(date);
	if (since != null && dateKey < normalizeDate(since)) {
		return false;
	}
	if (until != null && dateKey > normalizeDate(until)) {
		return false;
	}
	return true;
}

type EntryData = {
	timestamp: string;
	model: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
	project: string;
	sessionId: string;
};

export async function loadPiAgentData(options?: LoadOptions): Promise<EntryData[]> {
	const piPaths = getPiAgentPaths(options?.piPath);
	if (piPaths.length === 0) {
		return [];
	}

	const files = await globPiAgentFiles(piPaths);
	if (files.length === 0) {
		return [];
	}

	const processedHashes = new Set<string>();
	const entries: EntryData[] = [];

	for (const file of files) {
		const project = extractPiAgentProject(file);
		const sessionId = extractPiAgentSessionId(file);

		await processJSONLFileByLine(file, (line, lineIndex) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(piAgentMessageSchema, parsed);
				if (!result.success) {
					return;
				}

				const data = result.output;
				const usageEntries = [
					...(isPiAgentUsageEntry(data) ? [transformPiAgentUsage(data)] : []),
					...extractPiAgentSubagentUsageEntries(data),
				].filter((entry) => entry != null);

				for (const [resultIndex, transformed] of usageEntries.entries()) {
					if (transformed == null) {
						continue;
					}

					const hash = `pi:${file}:${lineIndex}:${resultIndex}`;
					if (processedHashes.has(hash)) {
						continue;
					}
					processedHashes.add(hash);

					entries.push({
						timestamp: data.timestamp,
						model: transformed.model,
						inputTokens: transformed.usage.input_tokens,
						outputTokens: transformed.usage.output_tokens,
						cacheCreationTokens: transformed.usage.cache_creation_input_tokens,
						cacheReadTokens: transformed.usage.cache_read_input_tokens,
						cost: transformed.costUSD ?? 0,
						project,
						sessionId,
					});
				}
			} catch {
				// Skip invalid lines
			}
		});
	}

	return entries;
}

function aggregateByModel(entries: EntryData[]): Map<
	string,
	{
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}
> {
	const modelMap = new Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: number;
		}
	>();

	for (const entry of entries) {
		const model = entry.model ?? 'unknown';
		const existing = modelMap.get(model) ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
		};

		existing.inputTokens += entry.inputTokens;
		existing.outputTokens += entry.outputTokens;
		existing.cacheCreationTokens += entry.cacheCreationTokens;
		existing.cacheReadTokens += entry.cacheReadTokens;
		existing.cost += entry.cost;

		modelMap.set(model, existing);
	}

	return modelMap;
}

function createBreakdowns(
	modelMap: Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: number;
		}
	>,
): Array<{
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
}> {
	return Array.from(modelMap.entries()).map(([modelName, data]) => ({
		modelName,
		...data,
	}));
}

function calculateTotals(entries: EntryData[]): {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	let totalCost = 0;

	for (const entry of entries) {
		inputTokens += entry.inputTokens;
		outputTokens += entry.outputTokens;
		cacheCreationTokens += entry.cacheCreationTokens;
		cacheReadTokens += entry.cacheReadTokens;
		totalCost += entry.cost;
	}

	return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost };
}

export async function loadPiAgentDailyData(options?: LoadOptions): Promise<DailyUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const date = formatDate(entry.timestamp, options?.timezone);
		if (!isInDateRange(date, options?.since, options?.until)) {
			continue;
		}

		const existing = grouped.get(date) ?? [];
		existing.push(entry);
		grouped.set(date, existing);
	}

	const results: DailyUsageWithSource[] = [];
	for (const [date, dateEntries] of grouped) {
		const modelMap = aggregateByModel(dateEntries);
		const totals = calculateTotals(dateEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		results.push({
			date,
			source: 'pi-agent',
			...totals,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) =>
		order === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date),
	);

	return results;
}

export async function loadPiAgentSessionData(
	options?: LoadOptions,
): Promise<SessionUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const key = `${entry.project}\x00${entry.sessionId}`;
		const existing = grouped.get(key) ?? [];
		existing.push(entry);
		grouped.set(key, existing);
	}

	const results: SessionUsageWithSource[] = [];
	for (const [key, sessionEntries] of grouped) {
		const [project, sessionId] = key.split('\x00') as [string, string];
		const modelMap = aggregateByModel(sessionEntries);
		const totals = calculateTotals(sessionEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		const lastActivity = sessionEntries.reduce((latest, entry) => {
			return entry.timestamp > latest ? entry.timestamp : latest;
		}, sessionEntries[0]?.timestamp ?? '');

		const lastDate = formatDate(lastActivity, options?.timezone);
		if (!isInDateRange(lastDate, options?.since, options?.until)) {
			continue;
		}

		results.push({
			sessionId,
			projectPath: project,
			source: 'pi-agent',
			...totals,
			lastActivity: lastDate,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) =>
		order === 'asc'
			? a.lastActivity.localeCompare(b.lastActivity)
			: b.lastActivity.localeCompare(a.lastActivity),
	);

	return results;
}

export async function loadPiAgentMonthlyData(
	options?: LoadOptions,
): Promise<MonthlyUsageWithSource[]> {
	const entries = await loadPiAgentData(options);

	const grouped = new Map<string, EntryData[]>();
	for (const entry of entries) {
		const month = formatMonth(entry.timestamp, options?.timezone);
		const date = formatDate(entry.timestamp, options?.timezone);
		if (!isInDateRange(date, options?.since, options?.until)) {
			continue;
		}

		const existing = grouped.get(month) ?? [];
		existing.push(entry);
		grouped.set(month, existing);
	}

	const results: MonthlyUsageWithSource[] = [];
	for (const [month, monthEntries] of grouped) {
		const modelMap = aggregateByModel(monthEntries);
		const totals = calculateTotals(monthEntries);
		const modelsUsed = Array.from(modelMap.keys());
		const modelBreakdowns = createBreakdowns(modelMap);

		results.push({
			month,
			source: 'pi-agent',
			...totals,
			modelsUsed,
			modelBreakdowns,
		});
	}

	const order = options?.order ?? 'desc';
	results.sort((a, b) =>
		order === 'asc' ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month),
	);

	return results;
}

if (import.meta.vitest != null) {
	describe('loadPiAgentData', () => {
		it('extracts normal assistant usage and a single nested subagent usage', async () => {
			await using fixture = await createFixture({
				sessions: {
					subagent: {
						'session-1.jsonl': [
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:00:00.000Z',
								message: {
									role: 'assistant',
									usage: {
										input: 100,
										output: 50,
										cacheRead: 2,
										cacheWrite: 3,
										cost: {
											total: 0.1,
										},
									},
								},
							}),
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:00:10.000Z',
								message: {
									role: 'assistant',
									toolName: 'subagent',
									details: {
										results: [
											{
												usage: {
													input: 12,
													output: 3,
													cacheRead: 1,
													cacheWrite: 0,
													totalTokens: 16,
													cost: {
														total: 0.03,
													},
												},
											},
										],
									},
								},
							}),
						].join('\n'),
				},
			},
			});

			const entries = await loadPiAgentData({
				piPath: fixture.getPath('sessions'),
			});

			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({
				project: 'subagent',
				sessionId: 'session-1',
				timestamp: '2025-02-01T00:00:00.000Z',
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 3,
				cacheReadTokens: 2,
				cost: 0.1,
			});
			expect(entries[1]).toMatchObject({
				project: 'subagent',
				sessionId: 'session-1',
				timestamp: '2025-02-01T00:00:10.000Z',
				inputTokens: 12,
				outputTokens: 3,
				cacheCreationTokens: 0,
				cacheReadTokens: 1,
				cost: 0.03,
			});
		});

		it('extracts all usage entries from multiple nested toolResult results, including equal token totals', async () => {
			await using fixture = await createFixture({
				sessions: {
					subagent: {
						'session-multi.jsonl': [
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:00:20.000Z',
								message: {
									role: 'assistant',
									toolName: 'subagent',
									details: {
										results: [
											{
												usage: {
													input: 5,
													output: 1,
													cacheRead: 0,
													cacheWrite: 0,
													totalTokens: 6,
													cost: {
														total: 0.06,
													},
												},
											},
											{
												usage: {
													input: 5,
													output: 1,
													cacheRead: 0,
													cacheWrite: 0,
													totalTokens: 6,
													cost: {
														total: 0.06,
													},
												},
											},
										],
									},
								},
							}),
						].join('\n'),
				},
			},
			});

			const entries = await loadPiAgentData({
				piPath: fixture.getPath('sessions'),
			});

			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({
				inputTokens: 5,
				outputTokens: 1,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0.06,
			});
			expect(entries[1]).toMatchObject({
				inputTokens: 5,
				outputTokens: 1,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0.06,
			});
		});

		it('skips malformed nested subagent usage while keeping valid usage', async () => {
			await using fixture = await createFixture({
				sessions: {
					subagent: {
						'session-malformed.jsonl': [
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:00:40.000Z',
								message: {
									role: 'assistant',
									usage: {
										input: 40,
										output: 10,
										cacheRead: 1,
										cacheWrite: 4,
										cost: {
											total: 0.2,
										},
									},
								},
							}),
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:00:50.000Z',
								message: {
									role: 'assistant',
									toolName: 'subagent',
									details: {
										results: [
											{
												usage: {
													input: 3,
													output: 1,
													cacheRead: 0,
													cacheWrite: 1,
													totalTokens: 5,
													cost: {
														total: 0.01,
													},
												},
											},
											{
												usage: {
													input: 'bad',
													output: 2,
												},
											},
											{
												foo: 'bar',
											},
											{
												usage: {
													input: 2,
													output: 1,
													cacheRead: 0,
													cacheWrite: 0,
													totalTokens: 3,
													cost: {
														total: 0.02,
													},
												},
											},
										],
									},
								},
							}),
						].join('\n'),
				},
			},
			});

			const entries = await loadPiAgentData({
				piPath: fixture.getPath('sessions'),
			});

			expect(entries).toHaveLength(3);
			expect(entries[0]).toMatchObject({ inputTokens: 40, outputTokens: 10, cost: 0.2 });
			expect(entries[1]).toMatchObject({ inputTokens: 3, outputTokens: 1, cost: 0.01 });
			expect(entries[2]).toMatchObject({ inputTokens: 2, outputTokens: 1, cost: 0.02 });
		});

		it('deduplicates by stable line/result identity instead of total tokens', async () => {
			await using fixture = await createFixture({
				sessions: {
					subagent: {
						'session-dedupe.jsonl': [
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:01:00.000Z',
								message: {
									role: 'assistant',
									usage: {
										input: 9,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: {
											total: 0.01,
										},
									},
								},
							}),
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:01:00.000Z',
								message: {
									role: 'assistant',
									usage: {
										input: 9,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: {
											total: 0.01,
										},
									},
								},
							}),
							JSON.stringify({
								type: 'message',
								timestamp: '2025-02-01T00:01:00.000Z',
								message: {
									role: 'assistant',
									toolName: 'subagent',
									details: {
										results: [
											{
												usage: {
													input: 9,
													output: 0,
													cacheRead: 0,
													cacheWrite: 0,
													totalTokens: 9,
													cost: {
														total: 0.01,
													},
												},
											},
											{
												usage: {
													input: 9,
													output: 0,
													cacheRead: 0,
													cacheWrite: 0,
													totalTokens: 9,
													cost: {
														total: 0.01,
													},
												},
											},
										],
									},
								},
							}),
						].join('\n'),
				},
			},
			});

			const entries = await loadPiAgentData({
				piPath: fixture.getPath('sessions'),
			});

			expect(entries).toHaveLength(4);
			expect(
				entries.map((entry) => entry.timestamp),
			).toEqual([
				'2025-02-01T00:01:00.000Z',
				'2025-02-01T00:01:00.000Z',
				'2025-02-01T00:01:00.000Z',
				'2025-02-01T00:01:00.000Z',
			]);
		});
	});
}
