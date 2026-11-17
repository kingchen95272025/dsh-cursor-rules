/**
 * Cursor Rules 规则引擎（宿主侧纯逻辑层，与 Cordis 无耦合）
 *
 * 把 Cursor 的 `.cursor/rules/**\/*.mdc` 规则文件解析成结构化规则，并按 Cursor 的
 * 四类规则语义选出「本次请求该注入哪些规则」：
 *
 * | Cursor 类型      | frontmatter                          | 注入时机                             |
 * | ---------------- | ------------------------------------ | ------------------------------------ |
 * | Always           | `alwaysApply: true`                  | 始终注入完整正文                      |
 * | Auto Attached    | `alwaysApply: false` + `globs: [...]` | 命中本会话已触达文件时注入             |
 * | Agent Requested  | `alwaysApply: false` + `description`  | 只登记进按需目录，由 Agent 自行 read    |
 * | Manual           | 其余                                  | 只登记进按需目录                      |
 *
 * 设计约束：**零第三方依赖**。frontmatter 解析与 glob 匹配都在本文件内实现，
 * 这样插件包放在任何目录（含被复制进 profile 的 node_modules）都能自洽运行，
 * 不依赖宿主可能未提升的传递依赖（yaml / picomatch）。
 *
 * @module dsh-cursor-rules/rules
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** 规则目录名（相对某个工作区目录）。 */
export const RULES_DIR_NAME = '.cursor/rules';

/**
 * 默认的用户级规则目录（按扫描顺序）。
 *
 * `~/.dsh/rules` 是 DSH 自己的全局规则位（本插件扩展位，非 Cursor 原生目录）；
 * `~/.cursor/rules` 作为 Cursor 兼容位保留在后。
 *
 * 注意：用户级规则的 id 为 `~/<相对 homedir 的路径>`（见 {@link displayPathOf}），
 * 目录名包含在 id 内，因此**不同目录下的同名文件是两条独立规则，不会互相覆盖**；
 * 该数组只决定扫描顺序，与项目层「更具体者覆盖更宽泛者」的语义无关。
 */
export const DEFAULT_USER_RULE_DIRS = ['~/.dsh/rules', '~/.cursor/rules'];

/** 规则文件扩展名。 */
export const RULE_EXTENSION = '.mdc';

/** 注入消息的 source.kind，用于在同一会话里识别本插件自己投递过的消息。 */
export const SOURCE_KIND = 'cursor-rules';

/** 默认的注入字节预算。 */
export const DEFAULT_MAX_BYTES = 131072;

/** 目录扫描深度上限，防御异常深层目录。 */
const MAX_SCAN_DEPTH = 8;

/** 扫描时忽略的目录名。 */
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.svn', '.hg', 'vendor']);

const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SYSTEM_REMINDER_ESCAPED = '<\\/system-reminder>';

/** 规则 -> glob 正则列表的弱引用缓存，避免每轮请求重复编译。 */
const matcherCache = new WeakMap();

/**
 * 把绝对路径统一成正斜杠形式，便于跨平台比较与 glob 匹配。
 * @param value - 任意路径。
 * @returns 使用 `/` 分隔的路径。
 */
export function toPosix(value) {
	return value.split(sep).join('/');
}

/**
 * 展开路径开头的 `~`。
 * @param value - 可能以 `~` 或 `~/` 开头的路径。
 * @returns 展开后的绝对路径。
 */
export function expandHome(value) {
	if (value === '~') return homedir();
	if (value.startsWith('~/')) return join(homedir(), value.slice(2));
	return value;
}

/**
 * 转义规则正文里可能出现的收尾标签，避免规则文件内容突破插件自有的
 * `<system-reminder>` 框（仓库内容不得改变框的边界）。
 * @param body - 规则正文。
 * @returns 转义后的正文。
 */
export function escapeFrameBody(body) {
	return body.replaceAll(SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_ESCAPED);
}

/**
 * 判断路径是否存在。
 * @param path - 绝对路径。
 * @returns 存在为 true。
 */
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// ── frontmatter 解析（YAML 子集，只覆盖 Cursor 规则用到的形态） ───────────────

/**
 * 去掉值末尾的行内注释（引号内的 `#` 不算注释）。
 * @param value - 原始值文本。
 * @returns 去注释后的文本。
 */
function stripComment(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
	const index = trimmed.indexOf(' #');
	return index === -1 ? trimmed : trimmed.slice(0, index).trimEnd();
}

/**
 * 去掉值两端成对的引号。
 * @param value - 原始值文本。
 * @returns 去引号后的文本。
 */
function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * 解析 `[a, b, c]` 形态的行内数组。
 * @param value - 以 `[` 开头的文本。
 * @returns 元素字符串列表。
 */
function parseInlineList(value) {
	const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
	const items = [];
	let buffer = '';
	let quote = '';
	for (const character of inner) {
		if (quote.length > 0) {
			if (character === quote) quote = '';
			else buffer += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ',') {
			items.push(buffer.trim());
			buffer = '';
			continue;
		}
		buffer += character;
	}
	items.push(buffer.trim());
	return items.filter((item) => item.length > 0);
}

/**
 * 解析 frontmatter 文本（YAML 子集）。
 *
 * 支持：`key: value`、带引号的值、行内数组 `[a, b]`、缩进块列表（`- item`）、
 * 行内注释。Cursor 规则的 frontmatter 只有 `description` / `globs` / `alwaysApply`
 * 三个字段，该子集足够覆盖其全部官方形态。
 *
 * @param text - frontmatter 原文（不含首尾 `---`）。
 * @returns 解析出的键值对象；无法识别的行被忽略。
 */
export function parseFrontmatterBlock(text) {
	const data = {};
	let currentKey;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\t/g, '  ');
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
		const itemMatch = /^-\s*(.*)$/.exec(trimmed);
		if (itemMatch !== null && currentKey !== undefined) {
			const item = unquote(stripComment(itemMatch[1]));
			if (item.length > 0) {
				if (!Array.isArray(data[currentKey])) data[currentKey] = [];
				data[currentKey].push(item);
			}
			continue;
		}
		const pairMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
		if (pairMatch === null) {
			currentKey = undefined;
			continue;
		}
		const key = pairMatch[1];
		const value = stripComment(pairMatch[2]);
		currentKey = key;
		if (value.length === 0) {
			data[key] = null;
			continue;
		}
		data[key] = value.startsWith('[') ? parseInlineList(value) : unquote(value);
	}
	return data;
}

/**
 * 拆分 Markdown frontmatter 与正文。
 *
 * 只把文件首个 `---` 行到下一个 `---` / `...` 行之间的内容当作 frontmatter；
 * 没有合法 frontmatter 时整份文件都是正文。
 *
 * @param text - 规则文件全文。
 * @returns frontmatter 原文（可能为 null）与正文。
 */
export function splitFrontmatter(text) {
	const source = text.replace(/^\uFEFF/, '');
	const lines = source.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return { frontmatter: null, body: source };
	let closing = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (line === '---' || line === '...') {
			closing = index;
			break;
		}
	}
	if (closing === -1) return { frontmatter: null, body: source };
	return {
		frontmatter: lines.slice(1, closing).join('\n'),
		body: lines.slice(closing + 1).join('\n').replace(/^\n+/, ''),
	};
}

/**
 * 归一化 `globs`：既接受 YAML 数组，也接受 Cursor 允许的逗号分隔字符串。
 * @param value - frontmatter 里的原始值。
 * @returns 去空后的 glob 列表。
 */
function normalizeGlobs(value) {
	const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return list
		.map((item) => String(item).trim())
		.filter((item) => item.length > 0);
}

/**
 * 归一化 `alwaysApply`：既接受布尔值，也接受 `"true"` / `"false"` 字符串。
 * @param value - frontmatter 里的原始值。
 * @returns 归一化后的布尔值。
 */
function normalizeAlwaysApply(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
	return false;
}

/**
 * 归一化 `description`。
 * @param value - frontmatter 里的原始值。
 * @returns 单行描述。
 */
function normalizeDescription(value) {
	if (typeof value === 'string') return value.trim();
	if (value === undefined || value === null) return '';
	return String(value).trim();
}

/**
 * 解析一份规则正文，得到 frontmatter 字段与正文。
 * @param text - 规则文件全文。
 * @returns `{ data, body, frontmatter }`。
 */
export function parseRuleText(text) {
	const { frontmatter, body } = splitFrontmatter(text);
	if (frontmatter === null) return { data: {}, body, frontmatter: null };
	return { data: parseFrontmatterBlock(frontmatter), body, frontmatter };
}

/**
 * 由 frontmatter + 正文推导 Cursor 的四类规则类型。
 * @param alwaysApply - 是否 alwaysApply。
 * @param globs - glob 列表。
 * @param description - 规则描述。
 * @returns `'always'`、`'auto'`、`'agent'` 或 `'manual'`。
 */
export function ruleTypeOf(alwaysApply, globs, description) {
	if (alwaysApply) return 'always';
	if (globs.length > 0) return 'auto';
	if (description.length > 0) return 'agent';
	return 'manual';
}

/**
 * 计算单条规则的内容指纹（路径 + 语义字段 + 正文）。
 * @param rule - 规则对象。
 * @returns 十六进制指纹。
 */
export function ruleDigest(rule) {
	return createHash('sha1')
		.update(`${rule.id}\u0000${String(rule.alwaysApply)}\u0000${rule.globs.join(',')}\u0000${rule.description}\u0000${rule.body}`)
		.digest('hex')
		.slice(0, 16);
}

/**
 * 计算按需目录的指纹，用于判断是否需要重新播报目录。
 * @param catalog - 按需目录规则列表。
 * @returns 十六进制指纹。
 */
export function catalogDigestOf(catalog) {
	const hash = createHash('sha1');
	for (const rule of [...catalog].sort((left, right) => left.id.localeCompare(right.id))) {
		hash.update(`${rule.id}\u0000${rule.type}\u0000${rule.description}\u0000${rule.globs.join(',')}\n`);
	}
	return hash.digest('hex').slice(0, 16);
}

// ── glob 匹配（自实现，语义对齐 bash / minimatch 的常用子集） ─────────────────

/**
 * 转义正则元字符。
 * @param value - 单个字符。
 * @returns 转义后的片段。
 */
function escapeRegExp(value) {
	return /[.*+?^${}()|[\]\\]/.test(value) ? `\\${value}` : value;
}

/**
 * 展开 `{a,b}` 花括号为多个 glob（支持嵌套）。
 * @param glob - 原始 glob。
 * @returns 展开后的 glob 列表。
 */
export function expandBraces(glob) {
	const start = glob.indexOf('{');
	if (start === -1) return [glob];
	let depth = 0;
	let end = -1;
	for (let index = start; index < glob.length; index += 1) {
		if (glob[index] === '{') depth += 1;
		else if (glob[index] === '}') {
			depth -= 1;
			if (depth === 0) {
				end = index;
				break;
			}
		}
	}
	if (end === -1) return [glob];
	const prefix = glob.slice(0, start);
	const suffix = glob.slice(end + 1);
	const body = glob.slice(start + 1, end);
	const parts = [];
	let buffer = '';
	depth = 0;
	for (const character of body) {
		if (character === '{') depth += 1;
		if (character === '}') depth -= 1;
		if (character === ',' && depth === 0) {
			parts.push(buffer);
			buffer = '';
			continue;
		}
		buffer += character;
	}
	parts.push(buffer);
	return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

/**
 * 把一个 glob 编译成正则。
 * @param glob - glob 文本。
 * @returns 锚定的正则表达式。
 */
export function compileGlob(glob) {
	const pattern = glob.replace(/\/+$/, '/**');
	let source = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*') {
			let stars = 0;
			while (pattern[index] === '*') {
				stars += 1;
				index += 1;
			}
			index -= 1;
			if (stars >= 2) {
				if (pattern[index + 1] === '/') {
					// `**/` 匹配零个或多个路径段
					index += 1;
					source += '(?:[^/]*/)*';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
			continue;
		}
		if (character === '?') {
			source += '[^/]';
			continue;
		}
		if (character === '[') {
			const closing = pattern.indexOf(']', index + 1);
			if (closing === -1) {
				source += '\\[';
				continue;
			}
			let body = pattern.slice(index + 1, closing);
			if (body.startsWith('!')) body = `^${body.slice(1)}`;
			source += `[${body}]`;
			index = closing;
			continue;
		}
		source += escapeRegExp(character);
	}
	return new RegExp(`^${source}$`);
}

/**
 * 编译一条规则的 globs 为匹配函数。
 * @param rule - 规则对象。
 * @returns 匹配函数。
 */
function matcherOf(rule) {
	const cached = matcherCache.get(rule);
	if (cached !== undefined) return cached;
	const matchers = rule.globs.flatMap((glob) => expandBraces(toPosix(glob)).map(compileGlob));
	matcherCache.set(rule, matchers);
	return matchers;
}

/**
 * 判断某个已触达文件是否命中规则的 globs。
 *
 * 依次尝试「相对项目根路径」「绝对路径」，对不含 `/` 的 glob 额外尝试文件名，
 * 兼顾 Cursor 的常规写法与用户手写的宽松写法。
 *
 * @param rule - 规则对象。
 * @param touchedPaths - 本会话已触达的文件路径（绝对或相对）。
 * @param projectRoot - 项目根绝对路径。
 * @returns 命中的路径；未命中返回 `undefined`。
 */
export function matchRule(rule, touchedPaths, projectRoot) {
	if (rule.globs.length === 0) return undefined;
	const matchers = matcherOf(rule);
	const bareGlobs = rule.globs.some((glob) => !toPosix(glob).includes('/'));
	for (const touched of touchedPaths) {
		const absolute = resolve(projectRoot, touched);
		const candidates = [toPosix(relative(projectRoot, absolute)), toPosix(absolute)];
		if (bareGlobs) candidates.push(basename(absolute));
		for (const candidate of candidates) {
			if (candidate.startsWith('..')) continue;
			if (matchers.some((matcher) => matcher.test(candidate))) return touched;
		}
	}
	return undefined;
}

// ── 发现与装载 ──────────────────────────────────────────────────────────────

/**
 * 从 `cwd` 逐级向上查找项目根（命中任一 marker 即停）。
 * @param cwd - 会话工作目录。
 * @param markers - 项目根标记名，例如 `.git`。
 * @param signal - 中止信号。
 * @returns 项目根绝对路径；找不到时返回起始目录。
 */
export async function findProjectRoot(cwd, markers, signal) {
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		signal?.throwIfAborted();
		for (const marker of markers) {
			if (await pathExists(join(current, marker))) return current;
		}
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/**
 * 构造 `projectRoot` → `cwd` 的目录链（由宽到窄）。
 * @param projectRoot - 项目根绝对路径。
 * @param cwd - 会话工作目录。
 * @returns 由宽到窄的目录列表。
 */
function directoryChain(projectRoot, cwd) {
	const root = resolve(projectRoot);
	const start = resolve(cwd);
	const chain = [];
	let current = start;
	for (let depth = 0; depth <= MAX_SCAN_DEPTH; depth += 1) {
		chain.push(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		if (!current.startsWith(root)) break;
		current = parent;
	}
	return chain.reverse();
}

/**
 * 递归收集一个目录下的全部 `.mdc` 文件（跟随符号链接的目录与文件）。
 * @param directory - 起始目录绝对路径。
 * @param signal - 中止信号。
 * @returns 绝对路径列表（已排序）。
 */
async function listRuleFiles(directory, signal) {
	const found = [];
	const visit = async (current, depth) => {
		if (depth > MAX_SCAN_DEPTH) return;
		signal?.throwIfAborted();
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			signal?.throwIfAborted();
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const info = await stat(join(current, entry.name));
					isDirectory = info.isDirectory();
					isFile = info.isFile();
				} catch {
					continue;
				}
			}
			if (isDirectory) {
				if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
				await visit(join(current, entry.name), depth + 1);
				continue;
			}
			if (!isFile) continue;
			if (!entry.name.toLowerCase().endsWith(RULE_EXTENSION)) continue;
			found.push(join(current, entry.name));
		}
	};
	await visit(directory, 0);
	return found.sort();
}

/**
 * 计算规则在界面与提示中展示的短路径。
 * @param absolutePath - 规则文件绝对路径。
 * @param scope - `'user'` 或 `'project'`。
 * @param projectRoot - 项目根绝对路径。
 * @returns 展示用路径。
 */
function displayPathOf(absolutePath, scope, projectRoot) {
	if (scope === 'user') return `~/${toPosix(relative(homedir(), absolutePath))}`;
	const relativePath = toPosix(relative(projectRoot, absolutePath));
	if (relativePath.startsWith('..')) return toPosix(absolutePath);
	return relativePath;
}

/**
 * 读取并解析单个规则文件。
 * @param absolutePath - 规则文件绝对路径。
 * @param scope - 来源作用域。
 * @param projectRoot - 项目根绝对路径。
 * @param disabled - 被关闭的规则 id 集合。
 * @param signal - 中止信号。
 * @returns 规则对象；读取失败时返回 `undefined`。
 */
async function loadRule(absolutePath, scope, projectRoot, disabled, signal) {
	let text;
	let info;
	try {
		[text, info] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
	} catch {
		return undefined;
	}
	signal?.throwIfAborted();
	const { data, body } = parseRuleText(text);
	const globs = normalizeGlobs(data.globs);
	const alwaysApply = normalizeAlwaysApply(data.alwaysApply);
	const description = normalizeDescription(data.description);
	const displayPath = displayPathOf(absolutePath, scope, projectRoot);
	return {
		id: displayPath,
		path: absolutePath,
		displayPath,
		scope,
		title: basename(absolutePath).replace(/\.mdc$/i, ''),
		description,
		globs,
		alwaysApply,
		type: ruleTypeOf(alwaysApply, globs, description),
		body,
		bytes: Buffer.byteLength(body, 'utf8'),
		mtimeMs: info.mtimeMs,
		enabled: !disabled.has(displayPath),
	};
}

/**
 * 收集一个工作区（含用户级目录）下的全部规则。
 *
 * 顺序遵循「由宽到窄」：用户级目录（按 `userRuleDirs` 给定顺序）在前，
 * 项目根到会话 cwd 的各层 `.cursor/rules` 依次在后；同名 id 以更具体
 * （更靠后）的一份为准——该覆盖只发生在项目层内部（用户级 id 含目录路径）。
 *
 * @param options - 收集选项。
 * @param options.cwd - 会话工作目录（绝对路径）。
 * @param options.projectRootMarkers - 项目根标记，默认 `['.git']`。
 * @param options.includeUserRules - 是否加载用户级规则。
 * @param options.userRuleDirs - 用户级规则目录数组，默认 `DEFAULT_USER_RULE_DIRS`。
 * @param options.disabled - 被关闭的规则 id 列表。
 * @param options.signal - 中止信号。
 * @returns `{ cwd, projectRoot, rules, warnings }`。
 */
export async function collectRules(options) {
	const {
		cwd,
		projectRootMarkers = ['.git'],
		includeUserRules = true,
		userRuleDirs = DEFAULT_USER_RULE_DIRS,
		disabled = [],
		signal,
	} = options;
	const warnings = [];
	const absoluteCwd = resolve(cwd);
	const projectRoot = await findProjectRoot(absoluteCwd, projectRootMarkers, signal);
	const disabledSet = new Set(disabled);

	const scanTargets = [];
	if (includeUserRules) {
		for (const directory of userRuleDirs) {
			scanTargets.push({ directory: resolve(expandHome(directory)), scope: 'user' });
		}
	}
	for (const directory of directoryChain(projectRoot, absoluteCwd)) {
		scanTargets.push({ directory: join(directory, RULES_DIR_NAME), scope: 'project' });
	}

	const byId = new Map();
	for (const target of scanTargets) {
		const files = await listRuleFiles(target.directory, signal);
		for (const file of files) {
			const rule = await loadRule(file, target.scope, projectRoot, disabledSet, signal);
			if (rule === undefined) {
				warnings.push(`unreadable rule file: ${file}`);
				continue;
			}
			byId.set(rule.id, rule);
		}
	}

	return {
		cwd: absoluteCwd,
		projectRoot,
		rules: [...byId.values()],
		warnings,
	};
}

/**
 * 按 Cursor 语义选出本次生效的规则与按需目录。
 * @param rules - 全部规则。
 * @param touchedPaths - 本会话已触达的文件路径。
 * @param projectRoot - 项目根绝对路径。
 * @returns `{ always, attached, catalog }`，其中 attached 元素形如 `{ rule, match }`。
 */
export function selectRules(rules, touchedPaths, projectRoot) {
	const always = [];
	const attached = [];
	const catalog = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.type === 'always') {
			always.push(rule);
			continue;
		}
		if (rule.type === 'auto') {
			const match = matchRule(rule, touchedPaths, projectRoot);
			if (match !== undefined) attached.push({ rule, match });
			else catalog.push(rule);
			continue;
		}
		catalog.push(rule);
	}
	return { always, attached, catalog };
}

/**
 * 渲染一条规则的标题行。
 * @param rule - 规则对象。
 * @param match - 触达命中的路径（Auto Attached 规则才有）。
 * @returns 标题行文本。
 */
function ruleHeading(rule, match) {
	if (rule.type === 'always') return `Cursor rule: ${rule.displayPath} (alwaysApply)`;
	if (match !== undefined) return `Cursor rule: ${rule.displayPath} (auto-attached by ${match})`;
	return `Cursor rule: ${rule.displayPath}`;
}

/**
 * 渲染按需目录条目。
 * @param rule - 规则对象。
 * @returns 目录行文本。
 */
function catalogLine(rule) {
	const kind = rule.type === 'auto' ? `auto: ${rule.globs.join(', ')}` : rule.type === 'agent' ? 'agent-requested' : 'manual';
	const description = rule.description.length > 0 ? ` — ${rule.description}` : '';
	return `- ${rule.displayPath} (${kind})${description}`;
}

/**
 * 组装一次注入计划：与上一次已投递的状态做差，只投递增量。
 *
 * @param options - 计划输入。
 * @param options.selection - `selectRules` 的结果。
 * @param options.previous - 上一次投递的 `{ entries, catalogDigest }`；首次为 undefined。
 * @param options.maxBytes - 本次注入的字节预算。
 * @returns `{ text, entries, changes, catalogDigest, truncated }`，无需投递时返回 `null`。
 */
export function planInjection({ selection, previous, maxBytes }) {
	const attachedRules = selection.attached.map((item) => item.rule);
	const activeRules = [...selection.always, ...attachedRules];
	const previousEntries = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry.digest]));
	const desiredEntries = activeRules.map((rule) => ({ id: rule.id, digest: ruleDigest(rule) }));
	const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
	const activeById = new Map(activeRules.map((rule) => [rule.id, rule]));

	const baseline = previous === undefined;
	const added = [];
	const changed = [];
	for (const entry of desiredEntries) {
		const before = previousEntries.get(entry.id);
		if (before === undefined) added.push(entry);
		else if (before !== entry.digest) changed.push(entry);
	}
	const removed = [];
	for (const entry of previous?.entries ?? []) {
		if (!desiredById.has(entry.id)) removed.push(entry);
	}

	const catalogDigest = catalogDigestOf(selection.catalog);
	const catalogChanged = baseline || catalogDigest !== previous?.catalogDigest;
	if (added.length === 0 && changed.length === 0 && removed.length === 0 && !catalogChanged) return null;

	const sections = [];
	const omitted = [];
	let used = 0;
	const append = (text) => {
		const size = Buffer.byteLength(text, 'utf8') + 2;
		if (used + size > maxBytes) return false;
		sections.push(text);
		used += size;
		return true;
	};

	const attachedById = new Map(selection.attached.map((item) => [item.rule.id, item.match]));
	const emitRule = (entry) => {
		const rule = activeById.get(entry.id);
		if (rule === undefined) return;
		const body = escapeFrameBody(rule.body.trimEnd());
		const heading = ruleHeading(rule, attachedById.get(rule.id));
		if (!append(`${heading}\n\n${body}`)) omitted.push(rule.displayPath);
	};

	if (baseline) {
		append(
			[
				'The following Cursor rules (.cursor/rules) may be relevant to your work. Use them as guidance when applicable.',
				'More specific rules take precedence over broader ones. They do not override system, developer, or direct user instructions.',
			].join('\n'),
		);
	} else if (added.length > 0 || changed.length > 0) {
		append('Additional Cursor rules now apply to your work. Follow them alongside the rules already in context.');
	}

	for (const entry of added) emitRule(entry);
	for (const entry of changed) emitRule(entry);

	if (removed.length > 0) {
		append(
			[
				`Cursor rules no longer apply: ${removed.map((entry) => entry.id).join(', ')}`,
				'',
				'The previously loaded content from these files is out of scope for the current work.',
			].join('\n'),
		);
	}

	if (catalogChanged && selection.catalog.length > 0) {
		const lines = selection.catalog.map(catalogLine);
		if (
			!append(
				['The following Cursor rules are available on demand. Read the rule file when the task touches its area:', '', ...lines].join('\n'),
			)
		) {
			omitted.push('(on-demand catalog)');
		}
	}

	if (omitted.length > 0) {
		sections.push(
			[
				`Cursor rules omitted by the ${maxBytes}-byte budget: ${omitted.join(', ')}`,
				'Raise the cursor-rules `maxBytes` config, or read an omitted rule file directly when it matters.',
			].join('\n'),
		);
	}

	const changes = [
		...added.map((entry) => ({ action: 'add', id: entry.id })),
		...changed.map((entry) => ({ action: 'update', id: entry.id })),
		...removed.map((entry) => ({ action: 'remove', id: entry.id })),
	];

	return {
		text: `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`,
		entries: desiredEntries,
		changes,
		catalogDigest,
		truncated: omitted.length > 0,
	};
}
