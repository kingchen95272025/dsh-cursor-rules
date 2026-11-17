/**
 * DSH 插件：Cursor Rules（宿主半边）
 *
 * 让 DSH 具备 Cursor「Cursor Rules」按钮背后的 mdc 规则加载机制：
 *
 * 1. 规则发现：用户级 `~/.dsh/rules` 与 `~/.cursor/rules`（前者优先）+ 项目根到会话 cwd 各层的 `.cursor/rules`，
 *    递归收集 `.mdc`，解析 frontmatter（`description` / `globs` / `alwaysApply`）。
 * 2. 上下文注入：在 `agent/pre-step` 把生效规则以 `<system-reminder>` 形式折进本轮
 *    进入批次，语义对齐 Cursor 的 Always / Auto Attached / Agent Requested / Manual。
 * 3. 面板数据：通过 `ctx.webServer` 暴露只读 JSON 接口，供浏览器半边
 *    「Cursor Rules」面板读取与开关规则。
 *
 * 参考实现：`@deepseek-ai/dsh-agent-instructions`（同为工作区指令注入器，
 * 本插件沿用其 source 自有、正文逐字、框标签转义、增量投递的约定）。
 *
 * @module dsh-cursor-rules
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_MAX_BYTES, DEFAULT_USER_RULE_DIRS, SOURCE_KIND, collectRules, planInjection, selectRules } from './rules.js';

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'dsh-cursor-rules';

/**
 * 本插件不依赖任何**必须**存在的服务：核心的规则注入只用到事件，
 * 因此 `inject` 保持为空，纯 headless 场景也能加载；
 * `webServer` / `sessions` 都是可选增强，分别用 `ctx.inject(['webServer'], …)`
 * 与惰性 `ctx.get('sessions')` 获取（前者必须有，否则冷启动会漏注册路由）。
 */
export const inject = [];

/** 传给工具的正文预览上限（字节）。 */
const PREVIEW_LIMIT = 4000;

/**
 * 插件代码版本，随 `GET <httpPath>/rules` 一起返回。
 *
 * 存在的意义：DSH 的 profile 只监听 patch 文件、不监听插件模块（`hmr.root` 为空），
 * 因此改了插件代码后无法靠热重载生效。响应里带版本号可以直接判断
 * 「当前进程跑的是哪一版代码」，避免再次出现「改完以为生效」的误判。
 */
const PLUGIN_VERSION = '1.1.1';

/** 插件配置。 */
export const Config = z.object({
	enabled: z.boolean().default(true),
	maxBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_BYTES),
	includeUserRules: z.boolean().default(true),
	/**
	 * 用户级规则目录（按扫描顺序）。默认 `['~/.dsh/rules', '~/.cursor/rules']`：
	 * DSH 自有全局规则位 + Cursor 兼容位。两处同名文件是两条独立规则（用户级 id 含目录路径）。
	 */
	userRuleDirs: z.array(z.string()).default([...DEFAULT_USER_RULE_DIRS]),
	projectRootMarkers: z.array(z.string()).default(['.git']),
	/** 浏览器面板使用的 HTTP 前缀路由。 */
	httpPath: z.string().default('/cursor-rules'),
	/** 开关状态文件名，落在 `$DSH_HOME` 下。 */
	stateFile: z.string().default('cursor-rules.json'),
	/** 是否按「已触达文件」自动附加 globs 规则。 */
	trackTouches: z.boolean().default(true),
});

/**
 * 组装运行时配置（补默认值并以 `$DSH_HOME` 解析状态文件绝对路径）。
 * @param config - Loader 传入的配置。
 * @returns 归一化后的运行时配置。
 */
function resolveConfig(config) {
	const merged = {
		enabled: config?.enabled ?? true,
		maxBytes: config?.maxBytes ?? DEFAULT_MAX_BYTES,
		includeUserRules: config?.includeUserRules ?? true,
		userRuleDirs: config?.userRuleDirs ?? [...DEFAULT_USER_RULE_DIRS],
		projectRootMarkers: config?.projectRootMarkers ?? ['.git'],
		httpPath: config?.httpPath ?? '/cursor-rules',
		stateFile: config?.stateFile ?? 'cursor-rules.json',
		trackTouches: config?.trackTouches ?? true,
	};
	const statePath = isAbsolute(merged.stateFile) ? merged.stateFile : join(resolveDshHome(), merged.stateFile);
	return { ...merged, statePath };
}

/**
 * 判断一条消息是否由本插件投递。
 * @param message - 会话消息。
 * @returns 是本插件消息时为 true。
 */
function isCursorRulesMessage(message) {
	return typeof message?.source === 'object' && message.source !== null && message.source.kind === SOURCE_KIND;
}

/**
 * 从一组消息中取最后一条本插件消息携带的投递状态。
 * @param messages - 消息序列。
 * @returns `{ entries, catalogDigest }`，没有时返回 `undefined`。
 */
function lastDeliveryState(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isCursorRulesMessage(message)) continue;
		const entries = Array.isArray(message.source.entries) ? message.source.entries : [];
		return { entries, catalogDigest: message.source.catalogDigest };
	}
	return undefined;
}

/**
 * 读取开关状态文件。
 * @param statePath - 状态文件绝对路径。
 * @returns `{ disabled }`；文件缺失或损坏时返回空状态。
 */
async function readState(statePath) {
	try {
		const parsed = JSON.parse(await readFile(statePath, 'utf8'));
		const disabled = Array.isArray(parsed?.disabled) ? parsed.disabled.filter((item) => typeof item === 'string') : [];
		return { disabled };
	} catch {
		return { disabled: [] };
	}
}

/**
 * 原子写入开关状态文件。
 * @param statePath - 状态文件绝对路径。
 * @param state - 待写入状态。
 * @returns 写入完成的 Promise。
 */
async function writeState(statePath, state) {
	await mkdir(dirname(statePath), { recursive: true });
	const temporary = `${statePath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ version: 1, disabled: [...state.disabled].sort() }, null, 2)}\n`, 'utf8');
	await rename(temporary, statePath);
}

/**
 * 读取请求正文。
 * @param request - node:http 请求。
 * @param limitBytes - 正文上限。
 * @returns 正文文本。
 */
async function readRequestBody(request, limitBytes = 65536) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limitBytes) throw new Error('request body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * 写出一个 JSON 响应。
 * @param response - node:http 响应。
 * @param status - HTTP 状态码。
 * @param payload - 可 JSON 序列化的载荷。
 * @returns 无。
 */
function sendJson(response, status, payload) {
	const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(body.length),
		'cache-control': 'no-store',
	});
	response.end(body);
}

/**
 * 为面板准备一条规则的传输形态（列表里不带完整正文，只带预览）。
 * @param rule - 完整规则。
 * @param includeBody - 是否包含完整正文。
 * @returns 面向前端的规则对象。
 */
function rulePayload(rule, includeBody) {
	const base = {
		id: rule.id,
		displayPath: rule.displayPath,
		path: rule.path,
		scope: rule.scope,
		title: rule.title,
		description: rule.description,
		globs: rule.globs,
		alwaysApply: rule.alwaysApply,
		type: rule.type,
		bytes: rule.bytes,
		mtimeMs: rule.mtimeMs,
		enabled: rule.enabled,
	};
	if (includeBody) return { ...base, body: rule.body };
	return {
		...base,
		preview: rule.body.length > PREVIEW_LIMIT ? `${rule.body.slice(0, PREVIEW_LIMIT)}…` : rule.body,
		truncated: rule.body.length > PREVIEW_LIMIT,
	};
}

/**
 * 插件主体：注册上下文注入、文件触达采集与面板 HTTP 接口。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 * @returns 无。
 */
export function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	if (!resolved.enabled) return;

	/** 每个会话已触达的文件路径（globs 规则自动附加的依据）。 */
	const touchedBySession = new WeakMap();
	/** 每个会话最近一次投递状态，用于同一轮内的重复抑制。 */
	const deliveredBySession = new WeakMap();
	/** 开关状态的内存缓存，避免每次请求都读盘。 */
	let stateCache;
	let stateLoading;

	/**
	 * 取得开关状态（带进程内缓存）。
	 * @returns 状态对象。
	 */
	const state = async () => {
		if (stateCache !== undefined) return stateCache;
		stateLoading ??= readState(resolved.statePath).then((loaded) => {
			stateCache = loaded;
			stateLoading = undefined;
			return loaded;
		});
		return stateLoading;
	};

	/**
	 * 以当前 cwd 收集规则全集。
	 * @param cwd - 会话工作目录。
	 * @param signal - 中止信号。
	 * @returns 收集结果。
	 */
	const gather = async (cwd, signal) => {
		const { disabled } = await state();
		return collectRules({
			cwd,
			projectRootMarkers: resolved.projectRootMarkers,
			includeUserRules: resolved.includeUserRules,
			userRuleDirs: resolved.userRuleDirs,
			disabled,
			signal,
		});
	};

	/** 记录一次文件触达（read / write / edit 与 fs/observed 两条来源）。 */
	const recordTouch = (session, path) => {
		if (!resolved.trackTouches || session === undefined || typeof path !== 'string' || path.length === 0) return;
		let bucket = touchedBySession.get(session);
		if (bucket === undefined) {
			bucket = new Set();
			touchedBySession.set(session, bucket);
		}
		bucket.add(path);
	};

	if (resolved.trackTouches) {
		ctx.on('tools/result', (exec, result) => {
			if (result?.isError) return;
			const tool = exec?.name;
			if (tool !== 'read' && tool !== 'write' && tool !== 'edit') return;
			const filePath = exec?.arguments?.file_path;
			if (typeof filePath !== 'string') return;
			recordTouch(exec.agent?.session, filePath.trim());
		});
		ctx.on('fs/observed', (target, _observation, actor) => {
			const session = actor?.agent?.session;
			const displayPath = target?.displayPath;
			recordTouch(session, typeof displayPath === 'string' ? displayPath : undefined);
		});
	}

	ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind === 'reject') return decision;
		const session = agent?.session;
		if (session === undefined) return decision;
		const cwd = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd();
		const touched = resolved.trackTouches ? [...(touchedBySession.get(session) ?? [])] : [];
		const gathered = await gather(cwd, signal);
		signal?.throwIfAborted();
		const selection = selectRules(gathered.rules, touched, gathered.projectRoot);
		const previous = lastDeliveryState(decision.messages) ?? lastDeliveryState(agent.inbox?.nextStep) ?? deliveredBySession.get(session);
		const plan = planInjection({ selection, previous, maxBytes: resolved.maxBytes });
		if (plan === null) return decision;
		const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
		if (lastClaimedIndex < 0) return decision;
		deliveredBySession.set(session, { entries: plan.entries, catalogDigest: plan.catalogDigest });
		const injected = createUserMessage({
			content: [{ type: 'text', text: plan.text }],
			source: {
				kind: SOURCE_KIND,
				form: 'rules',
				baseline: previous === undefined,
				entries: plan.entries,
				catalogDigest: plan.catalogDigest,
				changes: plan.changes,
			},
		});
		return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, injected) };
	});

	// ── 浏览器面板使用的只读 JSON 接口 ────────────────────────────────────────
	// `webServer` 是可选增强，但**必须**用 `ctx.inject` 等待它，不能一次性 `ctx.get`：
	// 冷启动时本插件的 apply 可能早于 webServer 就绪（`inject = []` 不阻塞），
	// 一次性读取会拿到 undefined 并静默跳过注册；热插拔时又恰好已经就绪，
	// 从而出现「热装能用、重启后 404」的假象。`ctx.inject` 会在服务可用时注册，
	// 并在 webServer 被替换后自动重新注册（DSH 的 webServer 生命周期允许被替换）。
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: 'prefix',
					path: resolved.httpPath,
					handler,
				}),
			'cursor-rules: http route',
		);
	});

	/**
	 * 解析请求对应的会话工作目录：优先宿主会话头，其次客户端上报，最后进程 cwd。
	 * @param sessionId - 查询参数里的会话 id。
	 * @param fallbackCwd - 查询参数里的 cwd。
	 * @returns 绝对工作目录。
	 */
	const cwdOf = (sessionId, fallbackCwd) => {
		if (typeof sessionId === 'string' && sessionId.length > 0) {
			try {
				const session = ctx.get('sessions')?.get(sessionId);
				const cwd = session?.header?.cwd;
				if (typeof cwd === 'string' && cwd.length > 0) return cwd;
			} catch {
				/* 会话不存在时退回客户端上报值 */
			}
		}
		if (typeof fallbackCwd === 'string' && fallbackCwd.length > 0 && isAbsolute(fallbackCwd)) return fallbackCwd;
		return process.cwd();
	};

	/**
	 * 组装面板快照。
	 * @param cwd - 会话工作目录。
	 * @returns 快照对象。
	 */
	const snapshot = async (cwd) => {
		const gathered = await gather(resolve(cwd), undefined);
		return {
			version: PLUGIN_VERSION,
			cwd: gathered.cwd,
			projectRoot: gathered.projectRoot,
			warnings: gathered.warnings,
			rules: gathered.rules.map((rule) => rulePayload(rule, false)),
			statePath: resolved.statePath,
			maxBytes: resolved.maxBytes,
		};
	};

	const handler = async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		const route = url.pathname.slice(resolved.httpPath.length).replace(/^\/+/, '');
		try {
			if (request.method === 'GET' && (route === '' || route === 'rules')) {
				const cwd = cwdOf(url.searchParams.get('sessionId') ?? undefined, url.searchParams.get('cwd') ?? undefined);
				sendJson(response, 200, await snapshot(cwd));
				return;
			}
			if (request.method === 'GET' && route === 'rule') {
				const cwd = cwdOf(url.searchParams.get('sessionId') ?? undefined, url.searchParams.get('cwd') ?? undefined);
				const id = url.searchParams.get('id');
				const gathered = await gather(resolve(cwd), undefined);
				const found = gathered.rules.find((rule) => rule.id === id);
				if (found === undefined) {
					sendJson(response, 404, { error: 'unknown rule', id });
					return;
				}
				sendJson(response, 200, { rule: rulePayload(found, true) });
				return;
			}
			if (request.method === 'POST' && route === 'toggle') {
				const body = JSON.parse((await readRequestBody(request)) || '{}');
				const id = body?.id;
				if (typeof id !== 'string' || id.length === 0) {
					sendJson(response, 400, { error: 'id is required' });
					return;
				}
				const current = await state();
				const disabled = new Set(current.disabled);
				if (body.enabled === false) disabled.add(id);
				else disabled.delete(id);
				stateCache = { disabled: [...disabled] };
				await writeState(resolved.statePath, stateCache);
				const cwd = cwdOf(body?.sessionId ?? undefined, body?.cwd ?? undefined);
				sendJson(response, 200, await snapshot(cwd));
				return;
			}
			sendJson(response, 404, { error: 'not found', route });
		} catch (error) {
			ctx.logger.warn('cursor-rules request failed: %o', error);
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
