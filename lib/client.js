/**
 * DSH 插件：Cursor Rules（浏览器半边）
 *
 * 提供两处 UI：
 * 1. `sidebar.panellist` + `main` —— 左栏导航的「Cursor 规则」行，点开占满主面板的整页；
 * 2. `settings.section`          —— 设置面板里的「Cursor 规则」分节（复用同一个面板组件）。
 *
 * 数据全部来自宿主半边的 `/cursor-rules` 只读 JSON 接口（规则发现与解析都在宿主侧，
 * 浏览器不重复实现一套 mdc 解析）。
 *
 * 本文件是**手写**的客户端包（无构建步骤）：宿主按 `dsh.client` 声明把 `lib/client.js`
 * 原样投递给浏览器，因此这里直接使用 `window.__ModuleLoader__.load({ id, factory })`
 * 约定，并且只 `require` 平台内置模块（react / react-jsx-runtime / UI primitives）。
 *
 * @module dsh-cursor-rules/client
 */

window.__ModuleLoader__.load({
	id: "dsh-cursor-rules",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { jsx, jsxs } = require("react/jsx-runtime");

		const {
			Button,
			MarkdownText,
			Modal,
			Switch,
			Tooltip,
			IconChecklistOutlineRegular,
			IconRefreshOutlineRegular,
		} = primitives;

		/** i18n 命名空间。 */
		const NS = "cursor-rules";
		/** 宿主半边注册的 HTTP 路由前缀，与 `Config.httpPath` 默认值一致。 */
		const ENDPOINT = "/cursor-rules";

		const zh = {
			nav: "Cursor 规则",
			title: "Cursor 规则",
			subtitle: "把 .cursor/rules 下的 mdc 规则按 Cursor 语义加载进 Agent 上下文。",
			scopeUser: "用户级",
			scopeProject: "项目级",
			typeAlways: "始终生效",
			typeAuto: "自动附加",
			typeAgent: "按需获取",
			typeManual: "手动",
			enabled: "已启用",
			disabled: "已关闭",
			refresh: "刷新",
			loading: "正在读取规则…",
			empty: "没有发现 .cursor/rules/**/*.mdc 规则文件。",
			failed: "读取规则失败",
			retry: "重试",
			noSession: "当前没有打开的工作区，显示的是宿主进程目录下的规则。",
			pillAll: "共 {total} 条",
			pillOn: "生效 {enabled} 条",
			pillOff: "关闭 {off} 条",
			emptyHint: "在仓库里放 .cursor/rules/*.mdc，用 frontmatter 的 alwaysApply / globs / description 决定它何时进入上下文。",
			open: "查看",
			close: "关闭",
			globs: "globs",
			bytes: "字节",
			statePath: "开关状态",
			toggleFailed: "切换失败",
			bodyFailed: "读取规则正文失败",
			omitted: "超出预算被省略",
		};
		const en = {
			nav: "Cursor Rules",
			title: "Cursor Rules",
			subtitle: "Load .cursor/rules mdc rules into agent context with Cursor semantics.",
			scopeUser: "User",
			scopeProject: "Project",
			typeAlways: "Always",
			typeAuto: "Auto attached",
			typeAgent: "Agent requested",
			typeManual: "Manual",
			enabled: "Enabled",
			disabled: "Disabled",
			refresh: "Refresh",
			loading: "Loading rules…",
			empty: "No .cursor/rules/**/*.mdc rule files were found.",
			failed: "Failed to load rules",
			retry: "Retry",
			noSession: "No workspace is open; showing rules under the host process directory.",
			pillAll: "{total} rules",
			pillOn: "{enabled} active",
			pillOff: "{off} off",
			emptyHint: "Add .cursor/rules/*.mdc files; the frontmatter alwaysApply / globs / description decides when each rule enters the context.",
			open: "View",
			close: "Close",
			globs: "globs",
			bytes: "bytes",
			statePath: "Toggle state",
			toggleFailed: "Toggle failed",
			bodyFailed: "Failed to load the rule body",
			omitted: "omitted by budget",
		};

		/**
		 * 把 `{placeholder}` 形式的模板替换成实际值。
		 * @param template - 模板文本。
		 * @param values - 占位符取值。
		 * @returns 替换后的文本。
		 */
		function format(template, values) {
			return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
		}

		/**
		 * 选取主视图正在展示的会话 id。
		 *
		 * 与 `dsh-client-ui-cordis` 的 CordisPanel 同一取法，保证设置面板与侧边栏按钮
		 * 指向同一个工作区会话。
		 *
		 * @param state - sessions store 快照。
		 * @returns 会话 id；没有时返回 undefined。
		 */
		function currentSessionIdOf(state) {
			for (const row of Object.values(state?.byId ?? {})) {
				if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id;
			}
			return undefined;
		}

		/**
		 * 解析规则接口地址。
		 * @param path - 子路径，例如 `rules`。
		 * @param sessionId - 会话 id。
		 * @param cwd - 会话工作目录。
		 * @returns 完整请求 URL。
		 */
		function endpointUrl(path, sessionId, cwd) {
			const search = new URLSearchParams();
			if (sessionId !== undefined) search.set("sessionId", sessionId);
			if (cwd !== undefined) search.set("cwd", cwd);
			const query = search.toString();
			return `${ENDPOINT}/${path}${query.length > 0 ? `?${query}` : ""}`;
		}

		/**
		 * 读取规则快照。
		 * @param sessionId - 会话 id。
		 * @param cwd - 会话工作目录。
		 * @param signal - 中止信号。
		 * @returns 宿主返回的快照。
		 */
		async function fetchSnapshot(sessionId, cwd, signal) {
			const response = await fetch(endpointUrl("rules", sessionId, cwd), { signal });
			if (!response.ok) throw new Error(`cursor-rules: HTTP ${String(response.status)}`);
			return response.json();
		}

		/**
		 * 读取单条规则正文。
		 * @param id - 规则 id（展示用相对路径）。
		 * @param sessionId - 会话 id。
		 * @param cwd - 会话工作目录。
		 * @param signal - 中止信号。
		 * @returns 规则对象（含 body）。
		 */
		async function fetchRule(id, sessionId, cwd, signal) {
			const response = await fetch(`${endpointUrl("rule", sessionId, cwd)}&id=${encodeURIComponent(id)}`, { signal });
			if (!response.ok) throw new Error(`cursor-rules: HTTP ${String(response.status)}`);
			return (await response.json()).rule;
		}

		/**
		 * 切换一条规则的开关。
		 * @param id - 规则 id。
		 * @param enabled - 目标状态。
		 * @param sessionId - 会话 id。
		 * @param cwd - 会话工作目录。
		 * @returns 宿主返回的最新快照。
		 */
		async function postToggle(id, enabled, sessionId, cwd) {
			const response = await fetch(endpointUrl("toggle", undefined, undefined), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id, enabled, sessionId, cwd }),
			});
			if (!response.ok) throw new Error(`cursor-rules: HTTP ${String(response.status)}`);
			return response.json();
		}

		/**
		 * 面板数据钩子：加载快照、切换开关、按需读取正文。
		 * @param sessionId - 会话 id。
		 * @param cwd - 会话工作目录。
		 * @returns 快照状态与操作函数。
		 */
		function useRuleSnapshot(sessionId, cwd) {
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(() => new Set());
			const [failure, setFailure] = react.useState();

			const reload = react.useCallback(
				async (signal) => {
					try {
						const snapshot = await fetchSnapshot(sessionId, cwd, signal);
						if (signal?.aborted) return;
						setState({ status: "ready", snapshot });
						setFailure(undefined);
					} catch (error) {
						if (signal?.aborted || error?.name === "AbortError") return;
						setFailure(error instanceof Error ? error.message : String(error));
						setState({ status: "failed" });
					}
				},
				[sessionId, cwd],
			);

			react.useEffect(() => {
				const controller = new AbortController();
				setState({ status: "loading" });
				reload(controller.signal);
				return () => {
					controller.abort();
				};
			}, [reload]);

			const toggle = react.useCallback(
				async (rule) => {
					setBusy((previous) => new Set(previous).add(rule.id));
					try {
						const snapshot = await postToggle(rule.id, !rule.enabled, sessionId, cwd);
						setState({ status: "ready", snapshot });
						setFailure(undefined);
					} catch (error) {
						setFailure(error instanceof Error ? error.message : String(error));
					} finally {
						setBusy((previous) => {
							const next = new Set(previous);
							next.delete(rule.id);
							return next;
						});
					}
				},
				[sessionId, cwd],
			);

			return { state, failure, busy, reload, toggle };
		}

		/** 注入到 <head> 的样式表元素 id：全局样式只需一份，卸载时按 id 摘掉。 */
		const STYLE_ID = "dsh-cursor-rules-style";

		/** 类名前缀：所有选择器都带它，避免与平台和其它插件的样式互相污染。 */
		const CLS = "dsrc";

		/**
		 * 页面样式表。
		 *
		 * 颜色、圆角一律取平台设计 token（都带兜底值），因此明暗主题下都成立；
		 * hover / transition 这类伪类行内样式表达不了，必须走样式表。
		 */
		const STYLE_TEXT = `
.${CLS}-page{box-sizing:border-box;height:100%;overflow-y:auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 28px) 32px 48px;}
.${CLS}-pageInner{display:flex;flex-direction:column;width:100%;max-width:920px;margin:0 auto;}
.${CLS}-panel{display:flex;flex-direction:column;min-height:0;}

.${CLS}-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l1,#00000014);}
.${CLS}-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#111);}
.${CLS}-subtitle{margin:6px 0 0;max-width:62ch;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary,#666);}
.${CLS}-stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.${CLS}-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:999px;font-size:11px;line-height:22px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:.5px solid var(--dsw-alias-border-l1,#00000014);}
.${CLS}-pill-strong{color:var(--dsw-alias-label-primary,#111);}
.${CLS}-headActions{display:flex;align-items:center;gap:8px;flex-shrink:0;padding-top:2px;}

.${CLS}-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--dsw-alias-label-tertiary,#999);}
.${CLS}-dot-on{background:var(--dsw-alias-state-success-primary,#2fa84f);}
.${CLS}-dot-always{background:var(--dsw-alias-brand-primary,#2f6fed);}
.${CLS}-dot-auto{background:var(--dsw-alias-state-success-primary,#2fa84f);}
.${CLS}-dot-agent{background:var(--dsw-alias-state-warn-primary,#c8871a);}

.${CLS}-group{display:flex;flex-direction:column;gap:10px;margin-top:26px;}
.${CLS}-groupHead{display:flex;align-items:center;gap:10px;}
.${CLS}-groupTitle{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#999);}
.${CLS}-groupCount{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;}
.${CLS}-groupRule{flex:1;height:1px;background:var(--dsw-alias-border-l1,#00000014);}
.${CLS}-list{display:flex;flex-direction:column;gap:8px;}

.${CLS}-row{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:var(--dsw-radius-lg,14px);border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3,#0000001f));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));transition:background .12s ease,border-color .12s ease;}
.${CLS}-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#f5f5f5));border-color:var(--dsw-alias-border-l2,#00000024);}
.${CLS}-row-off{opacity:.6;}
.${CLS}-rowMain{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1;}
.${CLS}-rowName{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.${CLS}-rowTitle{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,#111);}
.${CLS}-type{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:.5px solid var(--dsw-alias-border-l1,#00000014);}
.${CLS}-rowSize{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;}
.${CLS}-rowPath{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.${CLS}-rowText{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666);}
.${CLS}-rowActions{display:flex;align-items:center;gap:10px;flex-shrink:0;}

.${CLS}-note{margin:16px 0 0;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-secondary,#666);}
.${CLS}-note-warn{background:var(--dsw-alias-state-warn-tertiary,#fff7e6);color:var(--dsw-alias-state-warn-label,#8a5a00);}
.${CLS}-note-error{background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-state-error-primary,#d92d20);}
.${CLS}-empty{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:26px;padding:56px 24px;border-radius:var(--dsw-radius-lg,14px);border:1px dashed var(--dsw-alias-border-l2,#00000024);text-align:center;color:var(--dsw-alias-label-tertiary,#999);}
.${CLS}-emptyTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);}
.${CLS}-emptyHint{margin:0;max-width:46ch;font-size:12px;line-height:1.65;}
.${CLS}-foot{margin:24px 0 0;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,#00000014);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);word-break:break-all;}
.${CLS}-body{max-height:min(70vh,640px);overflow-y:auto;font-size:13px;line-height:1.75;}
`;

		/**
		 * 把样式表挂到 <head>（幂等）。
		 * @returns 卸载函数：移除本插件插入的那个 style 元素。
		 */
		function mountStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.getElementById(STYLE_ID) !== null) return () => {};
			const element = document.createElement("style");
			element.id = STYLE_ID;
			element.textContent = STYLE_TEXT;
			document.head.appendChild(element);
			return () => {
				element.remove();
			};
		}

		/**
		 * 把字节数格式化成紧凑的展示文本。
		 * @param bytes - 字节数。
		 * @returns 形如 `972 B` / `12.3 KB` 的文本。
		 */
		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
			return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
		}

		/**
		 * 规则类型标签：圆点区分四类语义，文字用标签样式（平台 `Tag` 不能带前置圆点，
		 * 但两者视觉规格一致，故本处自绘）。
		 * @param type - 规则类型。
		 * @param t - 本地化函数。
		 * @returns 标签元素。
		 */
		function TypeTag({ type, t }) {
			const tone = type === "always" || type === "auto" || type === "agent" ? type : "manual";
			const key = `type${tone[0].toUpperCase()}${tone.slice(1)}`;
			return jsxs("span", {
				className: `${CLS}-type`,
				children: [jsx("span", { className: `${CLS}-dot ${CLS}-dot-${tone}` }), t(key)],
			});
		}

		/**
		 * 单条规则行。
		 * @param props - 行属性。
		 * @returns 行元素。
		 */
		function RuleRow({ rule, busy, t, onToggle, onOpen }) {
			const globs = rule.globs.length > 0 ? `${t("globs")} ${rule.globs.join(", ")}` : undefined;
			return jsxs("div", {
				className: rule.enabled ? `${CLS}-row` : `${CLS}-row ${CLS}-row-off`,
				children: [
					jsxs("div", {
						className: `${CLS}-rowMain`,
						children: [
							jsxs("div", {
								className: `${CLS}-rowName`,
								children: [
									jsx("span", { className: `${CLS}-rowTitle`, children: rule.title }),
									jsx(TypeTag, { type: rule.type, t }),
									jsx("span", { className: `${CLS}-rowSize`, children: formatBytes(rule.bytes) }),
								],
							}),
							jsx("span", { className: `${CLS}-rowPath`, title: rule.path, children: rule.displayPath }),
							globs === undefined ? null : jsx("span", { className: `${CLS}-rowPath`, title: globs, children: globs }),
							rule.description.length > 0 ? jsx("span", { className: `${CLS}-rowText`, children: rule.description }) : null,
						],
					}),
					jsxs("div", {
						className: `${CLS}-rowActions`,
						children: [
							jsx(Button, { variant: "ghost", onClick: () => onOpen(rule), children: t("open") }),
							jsx(Switch, {
								checked: rule.enabled,
								disabled: busy,
								label: rule.enabled ? t("enabled") : t("disabled"),
								onChange: () => onToggle(rule),
							}),
						],
					}),
				],
			});
		}

		/**
		 * 规则正文弹窗。
		 * @param props - 弹窗属性。
		 * @returns 弹窗元素。
		 */
		function RuleBodyModal({ rule, sessionId, cwd, t, onClose }) {
			const [body, setBody] = react.useState();
			const [failure, setFailure] = react.useState();
			react.useEffect(() => {
				if (rule === undefined) return undefined;
				const controller = new AbortController();
				setBody(undefined);
				setFailure(undefined);
				fetchRule(rule.id, sessionId, cwd, controller.signal)
					.then((full) => {
						if (!controller.signal.aborted) setBody(full.body);
					})
					.catch((error) => {
						if (controller.signal.aborted || error?.name === "AbortError") return;
						setFailure(error instanceof Error ? error.message : String(error));
					});
				return () => {
					controller.abort();
				};
			}, [rule, sessionId, cwd]);
			if (rule === undefined) return null;
			return jsx(Modal, {
				open: true,
				onClose,
				closeLabel: t("close"),
				title: rule.displayPath,
				footer: jsx(Button, { variant: "outline", onClick: onClose, children: t("close") }),
				children: jsxs("div", {
					className: `${CLS}-body`,
					children: [
						failure === undefined ? null : jsx("p", { className: `${CLS}-note ${CLS}-note-error`, children: `${t("bodyFailed")}: ${failure}` }),
						body === undefined
							? failure === undefined
								? jsx("p", { className: `${CLS}-note`, children: t("loading") })
								: null
							: jsx(MarkdownText, { text: body }),
					],
				}),
			});
		}

		/**
		 * 规则总览（左栏整页与设置分节共用同一份实现）。
		 * @param props - 面板属性。
		 * @returns 面板元素。
		 */
		function RulesPanel({ sessionId, cwd, t }) {
			const { state, failure, busy, reload, toggle } = useRuleSnapshot(sessionId, cwd);
			const [opened, setOpened] = react.useState();
			const snapshot = state.snapshot;
			const rules = snapshot?.rules ?? [];
			const enabledCount = rules.filter((rule) => rule.enabled).length;
			const groups = react.useMemo(() => {
				const order = ["always", "auto", "agent", "manual"];
				const byScope = new Map();
				for (const rule of rules) {
					const bucket = byScope.get(rule.scope) ?? [];
					bucket.push(rule);
					byScope.set(rule.scope, bucket);
				}
				for (const bucket of byScope.values()) {
					bucket.sort((left, right) => order.indexOf(left.type) - order.indexOf(right.type) || left.title.localeCompare(right.title));
				}
				return [...byScope.entries()];
			}, [rules]);

			const statPills = [
				{ key: "pillAll", className: `${CLS}-pill ${CLS}-pill-strong`, text: format(t("pillAll"), { total: rules.length }) },
				{ key: "pillOn", className: `${CLS}-pill`, dot: `${CLS}-dot-on`, text: format(t("pillOn"), { enabled: enabledCount }) },
			];
			if (rules.length > enabledCount) {
				statPills.push({ key: "pillOff", className: `${CLS}-pill`, dot: `${CLS}-dot`, text: format(t("pillOff"), { off: rules.length - enabledCount }) });
			}

			return jsxs("div", {
				className: `${CLS}-panel`,
				children: [
					jsxs("div", {
						className: `${CLS}-head`,
						children: [
							jsxs("div", {
								children: [
									jsx("h1", { className: `${CLS}-title`, children: t("title") }),
									jsx("p", { className: `${CLS}-subtitle`, children: t("subtitle") }),
									snapshot === undefined
										? null
										: jsx("div", {
												className: `${CLS}-stats`,
												children: statPills.map((pill) =>
													jsxs(
														"span",
														{
															className: pill.className,
															children: [
																pill.dot === undefined ? null : jsx("span", { className: `${CLS}-dot ${pill.dot}` }),
																pill.text,
															],
														},
														pill.key,
													),
												),
											}),
								],
							}),
							jsx("div", {
								className: `${CLS}-headActions`,
								children: jsx(Tooltip, {
									label: t("refresh"),
									side: "bottom",
									children: jsx(Button, {
										variant: "ghost",
										onClick: () => {
											reload();
										},
										children: jsx(IconRefreshOutlineRegular, { size: 14 }),
									}),
								}),
							}),
						],
					}),
					sessionId === undefined ? jsx("p", { className: `${CLS}-note ${CLS}-note-warn`, children: t("noSession") }) : null,
					failure === undefined ? null : jsx("p", { className: `${CLS}-note ${CLS}-note-error`, children: `${t("failed")}: ${failure}` }),
					rules.length === 0
						? jsxs("div", {
								className: `${CLS}-empty`,
								children: [
									jsx(IconChecklistOutlineRegular, { size: 20 }),
									jsx("p", { className: `${CLS}-emptyTitle`, children: state.status === "loading" ? t("loading") : t("empty") }),
									state.status === "loading" ? null : jsx("p", { className: `${CLS}-emptyHint`, children: t("emptyHint") }),
								],
							})
						: groups.map(([scope, bucket]) =>
								jsxs(
									"section",
									{
										className: `${CLS}-group`,
										children: [
											jsxs("div", {
												className: `${CLS}-groupHead`,
												children: [
													jsx("span", { className: `${CLS}-groupTitle`, children: scope === "user" ? t("scopeUser") : t("scopeProject") }),
													jsx("span", { className: `${CLS}-groupCount`, children: String(bucket.length) }),
													jsx("span", { className: `${CLS}-groupRule` }),
												],
											}),
											jsx("div", {
												className: `${CLS}-list`,
												children: bucket.map((rule) =>
													jsx(
														RuleRow,
														{
															rule,
															busy: busy.has(rule.id),
															t,
															onToggle: toggle,
															onOpen: setOpened,
														},
														rule.id,
													),
												),
											}),
										],
									},
									scope,
								),
							),
					snapshot === undefined
						? null
						: jsx("p", { className: `${CLS}-foot`, children: `${t("statePath")}: ${snapshot.statePath}` }),
					jsx(RuleBodyModal, { rule: opened, sessionId, cwd, t, onClose: () => setOpened(undefined) }),
				],
			});
		}

		/**
		 * 设置面板中的「Cursor Rules」整页。
		 * @param props - 组合后的 slot props。
		 * @returns 页面元素。
		 */
		function CursorRulesSection(props) {
			const { useSessions, t } = props;
			const sessionId = useSessions(currentSessionIdOf);
			const cwd = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
			return jsx(RulesPanel, { sessionId, cwd, t });
		}

		/**
		 * 左栏导航行的图标（`sidebar.panellist` 的注册组件）。
		 * @param owner - 侧边栏传入的尺寸信息，缺省按 16 绘制。
		 * @returns 图标元素。
		 */
		function CursorRulesIcon(owner) {
			return jsx(IconChecklistOutlineRegular, { size: owner?.size ?? 16 });
		}

		/**
		 * 左栏导航打开的整页（`main` 座位）。
		 *
		 * 页面宿主只提供全局 hook，取不到 `useSessions` 时退化为「用户级规则 + 宿主进程目录」，
		 * 由面板自己显示 `noSession` 提示，不阻断整页渲染。
		 *
		 * @param props - 组合后的 slot props。
		 * @returns 页面元素。
		 */
		function CursorRulesPage(props) {
			const { t } = props;
			const useSessionsHook = typeof props.useSessions === "function" ? props.useSessions : undefined;
			const sessionId = useSessionsHook === undefined ? undefined : useSessionsHook(currentSessionIdOf);
			const cwd =
				useSessionsHook === undefined
					? undefined
					: useSessionsHook((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
			return jsx("div", {
				className: `${CLS}-page`,
				children: jsx("div", {
					className: `${CLS}-pageInner`,
					children: jsx(RulesPanel, { sessionId, cwd, t }),
				}),
			});
		}

		/** 左栏导航行的标识：既是 `sidebar.panellist` 行 id，也是 `main` 座位的 key，二者必须一致。 */
		const PANEL_ID = "cursor-rules";

		/** 依赖的客户端服务：slots 注册座位、locale 注册词条、sessions 定位当前工作区。 */
		const inject = ["slots", "locale", "sessions"];

		/**
		 * 客户端插件主体：注册词条、设置页与左栏导航面板。
		 * @param ctx - 客户端根上下文。
		 * @returns 无。
		 */
		function apply(ctx) {
			ctx.effect(() => mountStyles(), "cursor-rules: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "cursor-rules: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: PANEL_ID,
						order: 30,
						label: () => ctx.locale.bind(NS)("nav"),
						locale: NS,
					},
					CursorRulesSection,
				),
			);
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 30,
						label: () => ctx.locale.bind(NS)("nav"),
						locale: NS,
					},
					CursorRulesIcon,
				),
			);
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS,
						inject: () => ({ t }),
					},
					CursorRulesPage,
				),
			);
			ctx.inject(["layout"], (scoped) => {
				const layout = scoped.layout;
				ctx.effect(
					() => () => {
						if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null);
					},
					"cursor-rules: sidebar panel cleanup",
				);
			});
			void t;
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
