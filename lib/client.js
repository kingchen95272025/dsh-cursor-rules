/**
 * DSH 插件：Cursor Rules（浏览器半边）
 *
 * 提供两处 UI：
 * 1. `sidebar.footer.action` —— 侧边栏底部的「Cursor Rules」按钮，点开浮层查看/开关规则；
 * 2. `settings.section`     —— 设置面板里的「Cursor Rules」整页。
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
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

		const {
			Button,
			MarkdownText,
			Modal,
			Switch,
			Tag,
			Tooltip,
			IconChecklistOutlineRegular,
			IconRefreshOutlineRegular,
			IconWarningOutlineRegular,
		} = primitives;

		/** i18n 命名空间。 */
		const NS = "cursor-rules";
		/** 宿主半边注册的 HTTP 路由前缀，与 `Config.httpPath` 默认值一致。 */
		const ENDPOINT = "/cursor-rules";

		const zh = {
			nav: "Cursor Rules",
			title: "Cursor Rules",
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
			summary: "共 {total} 条 · 生效 {enabled} 条",
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
			summary: "{total} rules · {enabled} active",
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

		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "12px",
				minHeight: "0",
			},
			header: {
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: "12px",
			},
			title: {
				margin: "0 0 4px",
				fontSize: "14px",
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)",
			},
			subtitle: {
				margin: 0,
				fontSize: "12px",
				lineHeight: 1.6,
				color: "var(--dsw-alias-label-secondary)",
			},
			summary: {
				margin: "6px 0 0",
				fontSize: "12px",
				color: "var(--dsw-alias-label-secondary)",
			},
			groupTitle: {
				margin: "4px 0 0",
				fontSize: "12px",
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)",
			},
			list: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				overflowY: "auto",
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-1)",
			},
			rowMain: {
				display: "flex",
				flexDirection: "column",
				gap: "4px",
				minWidth: 0,
				flex: 1,
			},
			rowName: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				flexWrap: "wrap",
			},
			rowTitle: {
				fontSize: "13px",
				fontWeight: 500,
				color: "var(--dsw-alias-label-primary)",
			},
			rowPath: {
				fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			rowGlobs: {
				fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			rowActions: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				flexShrink: 0,
			},
			rowOff: {
				opacity: 0.55,
			},
			notice: {
				fontSize: "12px",
				color: "var(--dsw-alias-label-secondary)",
			},
			error: {
				fontSize: "12px",
				color: "var(--dsw-alias-state-error-primary)",
			},
			body: {
				maxHeight: "60vh",
				overflowY: "auto",
				fontSize: "12px",
			},
			trigger: {
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: "6px",
				width: "100%",
				padding: "6px 8px",
				borderRadius: "8px",
				border: "1px solid transparent",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
			},
			badge: {
				minWidth: "18px",
				padding: "0 5px",
				borderRadius: "9px",
				fontSize: "11px",
				lineHeight: "16px",
				textAlign: "center",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)",
			},
		};

		/**
		 * 规则类型标签。
		 * @param type - 规则类型。
		 * @param t - 本地化函数。
		 * @returns Tag 元素。
		 */
		function TypeTag({ type, t }) {
			const tone = type === "always" ? "solid" : type === "auto" ? "outline" : "neutral";
			const key = type === "always" ? "typeAlways" : type === "auto" ? "typeAuto" : type === "agent" ? "typeAgent" : "typeManual";
			return jsx(Tag, { tone, children: t(key) });
		}

		/**
		 * 单条规则行。
		 * @param props - 行属性。
		 * @returns 行元素。
		 */
		function RuleRow({ rule, busy, t, onToggle, onOpen }) {
			const globs = rule.globs.length > 0 ? `${t("globs")}: ${rule.globs.join(", ")}` : undefined;
			return jsxs("div", {
				style: { ...styles.row, ...(rule.enabled ? {} : styles.rowOff) },
				children: [
					jsxs("div", {
						style: styles.rowMain,
						children: [
							jsxs("div", {
								style: styles.rowName,
								children: [
									jsx("span", { style: styles.rowTitle, children: rule.title }),
									jsx(TypeTag, { type: rule.type, t }),
									rule.alwaysApply ? null : jsx(Tag, { tone: "neutral", children: `${String(rule.bytes)} B` }),
								],
							}),
							jsx("span", { style: styles.rowPath, title: rule.path, children: rule.displayPath }),
							globs === undefined ? null : jsx("span", { style: styles.rowGlobs, title: globs, children: globs }),
							rule.description.length > 0 ? jsx("span", { style: styles.rowGlobs, children: rule.description }) : null,
						],
					}),
					jsxs("div", {
						style: styles.rowActions,
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
					style: styles.body,
					children: [
						failure === undefined ? null : jsx("p", { style: styles.error, children: `${t("bodyFailed")}: ${failure}` }),
						body === undefined
							? failure === undefined
								? jsx("p", { style: styles.notice, children: t("loading") })
								: null
							: jsx(MarkdownText, { text: body }),
					],
				}),
			});
		}

		/**
		 * 规则总览（设置页与浮层共用）。
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

			return jsxs("div", {
				style: styles.root,
				children: [
					jsxs("div", {
						style: styles.header,
						children: [
							jsxs("div", {
								children: [
									jsx("h3", { style: styles.title, children: t("title") }),
									jsx("p", { style: styles.subtitle, children: t("subtitle") }),
									snapshot === undefined
										? null
										: jsx("p", {
												style: styles.summary,
												children: format(t("summary"), { total: rules.length, enabled: enabledCount }),
											}),
									sessionId === undefined ? jsx("p", { style: styles.notice, children: t("noSession") }) : null,
								],
							}),
							jsx(Tooltip, {
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
						],
					}),
					failure === undefined ? null : jsx("p", { style: styles.error, children: `${t("failed")}: ${failure}` }),
					state.status === "loading" && snapshot === undefined
						? jsx("p", { style: styles.notice, children: t("loading") })
						: null,
					state.status !== "loading" && rules.length === 0
						? jsx("p", { style: styles.notice, children: t("empty") })
						: null,
					...groups.map(([scope, bucket]) =>
						jsxs(
							Fragment,
							{
								children: [
									jsx("p", { style: styles.groupTitle, children: scope === "user" ? t("scopeUser") : t("scopeProject") }),
									jsx("div", {
										style: styles.list,
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
						: jsx("p", { style: styles.notice, children: `${t("statePath")}: ${snapshot.statePath}` }),
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
		 * 侧边栏底部的「Cursor Rules」按钮与浮层。
		 * @param props - 组合后的 slot props。
		 * @returns 按钮元素。
		 */
		function CursorRulesButton(props) {
			const { wide, useSessions, t } = props;
			const [open, setOpen] = react.useState(false);
			const sessionId = useSessions(currentSessionIdOf);
			const cwd = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd));
			return jsxs(Fragment, {
				children: [
					jsx(Tooltip, {
						label: t("nav"),
						side: "top",
						children: jsxs("button", {
							type: "button",
							style: styles.trigger,
							"aria-label": t("nav"),
							onClick: () => setOpen(true),
							children: [
								jsx(IconChecklistOutlineRegular, { size: 16 }),
								wide ? jsx("span", { children: t("nav") }) : null,
							],
						}),
					}),
					jsx(Modal, {
						open,
						onClose: () => setOpen(false),
						closeLabel: t("close"),
						title: t("title"),
						children: open
							? jsx(RulesPanel, { sessionId, cwd, t })
							: null,
					}),
				],
			});
		}

		/** 依赖的客户端服务：slots 注册座位、locale 注册词条、sessions 定位当前工作区。 */
		const inject = ["slots", "locale", "sessions"];

		/**
		 * 客户端插件主体：注册词条、设置页与侧边栏按钮。
		 * @param ctx - 客户端根上下文。
		 * @returns 无。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "cursor-rules: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "cursor-rules",
						order: 30,
						label: () => ctx.locale.bind(NS)("nav"),
						locale: NS,
					},
					CursorRulesSection,
				),
			);
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "cursor-rules",
						order: 50,
						label: () => ctx.locale.bind(NS)("nav"),
						locale: NS,
					},
					CursorRulesButton,
				),
			);
			void t;
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
