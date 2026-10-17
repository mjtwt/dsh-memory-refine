/**
 * Client half of the memory-refine bundle.
 *
 * It owns exactly one surface: a sidebar entry plus the central panel it opens.
 * The panel never touches the filesystem itself — every read and write goes
 * through the Host half, which keeps the version check, the backup and the
 * read-back verification. The first-choice channel is the Host's own HTTP route
 * (`POST /memory-refine/ui`), which never enters the command bus and therefore
 * leaves nothing in the conversation log; the `/memory-refine` slash command
 * stays as a fallback for when that route is not reachable.
 *
 * No build chain is involved, so this file is plain browser ESM wrapped in the
 * Harness module loader. React comes from the browser module table.
 */
window.__ModuleLoader__.load({
	id: 'dsh-memory-refine',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/* ------------------------------------------------------------ 样式 */

		const CSS = [
			".mrf-root{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:14px 16px 18px;font-size:13px;color:var(--dsw-alias-label-primary)}",
			".mrf-head{display:flex;align-items:baseline;gap:10px;flex:0 0 auto}",
			".mrf-title{margin:0;font-size:16px;font-weight:600;line-height:24px}",
			".mrf-home{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mrf-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}",
			".mrf-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}",
			".mrf-btn:disabled{opacity:.45;cursor:default}",
			".mrf-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".mrf-btn-primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
			".mrf-msg{flex:0 0 auto;padding:6px 10px;border-radius:6px;font-size:12px;line-height:18px}",
			".mrf-err{color:var(--dsw-alias-state-error-primary,#c0392b);border:.5px solid var(--dsw-alias-border-l2)}",
			".mrf-notice{color:var(--dsw-alias-state-success-primary,#2f855a);border:.5px solid var(--dsw-alias-border-l2)}",
			".mrf-body{display:flex;gap:14px;flex:1 1 auto;min-height:0}",
			".mrf-list{list-style:none;margin:0;padding:0;width:230px;flex:0 0 230px;overflow:auto;border-right:.5px solid var(--dsw-alias-border-l2)}",
			".mrf-item{padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px}",
			".mrf-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".mrf-item-on{background:var(--dsw-alias-interactive-bg-selected,rgba(127,127,127,.2))}",
			".mrf-group-toggle{padding:7px 8px 4px;margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));cursor:pointer;user-select:none}",
			".mrf-group-toggle:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".mrf-btn-danger{color:var(--dsw-alias-label-error,#d9534f);border-color:var(--dsw-alias-label-error,rgba(217,83,79,.6))}",
			".mrf-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;margin:0 0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-label-error,rgba(217,83,79,.6));font-size:12px;line-height:17px}",
			".mrf-item-path{font-size:12px;line-height:17px;word-break:break-all}",
			".mrf-item-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}",
			".mrf-editor{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:0;min-height:0}",
			".mrf-editor-head{display:flex;align-items:center;gap:8px;flex:0 0 auto}",
			".mrf-doc{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mrf-spacer{margin-left:auto}",
			".mrf-text{flex:1 1 auto;min-height:200px;width:100%;box-sizing:border-box;resize:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;padding:8px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}",
			".mrf-text:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}",
			".mrf-field{display:flex;gap:8px;align-items:center;flex:0 0 auto}",
			".mrf-label{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}",
			".mrf-input{font:inherit;font-size:12px;line-height:18px;padding:4px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);min-width:0;flex:1 1 auto}",
			".mrf-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 8px}",
		].join("");
		const CSS_TAG = "dsh-memory-refine/panel.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-memory-refine";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const PANEL_KEY = "memory-refine";
		/** 兜底通道：斜杠命令。载荷是 `/memory-refine ` + JSON。 */
		const BRIDGE = "/memory-refine ";
		/** 首选通道：Host 自挂的 HTTP 路由。不经过命令总线，所以不留痕。 */
		const HTTP_ENDPOINT = "/memory-refine/ui";
		const LAYER_LABEL = { inject: "注入层", index: "索引", topic: "常记", archive: "存档" };

		/** 通道状态。模块级：面板重挂载后仍然有效，渲染时直接读。 */
		const channel = { warn: "" };

		/* ------------------------------------------------ 从面板 props 找会话 */

		/**
		 * 面板插槽把 `useSessions` / `useWorkspaces` 作为 props 交下来；两者都是
		 * store selector（`SnapshotSelectorHook<T> = <S>(sel, eq?) => S`），不是
		 * React hook，可以在普通函数里调。
		 *
		 * `useSessions` 的官方快照形状是
		 * `{ byId: { [sessionId]: { id, cwd, blank, retainedBy: { mainView } } } }`，
		 * 官方找「当前会话」的标准写法见 `dsh-client-ui-cordis/lib/client.js`：
		 *   useSessions((state) => Object.values(state.byId)
		 *     .find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id)
		 * 这里优先照抄这个判据；用户只是开了本面板、没开会话时退回 byId 的最后一项。
		 * 形状在版本之间可能变，所以官方形状拿不到就退回通用形状试探，全空则返回
		 * null —— 上层据此给出人话提示，而不是静默失败。
		 */
		function sessionIdOf(entry) {
			if (!entry || typeof entry !== "object") return null;
			const id = entry.id || entry.sessionId || entry.sessionID || entry.session;
			return typeof id === "string" && id ? id : null;
		}

		function pickSessionId(props) {
			const hooks = [props && props.useSessions, props && props.useWorkspaces];
			for (const hook of hooks) {
				if (typeof hook !== "function") continue;
				try {
					const byId = hook((s) => (s && typeof s === "object" ? s.byId : null));
					if (byId && typeof byId === "object") {
						const all = Object.values(byId).filter((x) => x && typeof x === "object");
						const held = all.find((x) => x.retainedBy && ((x.retainedBy.mainView | 0) > 0));
						const id = sessionIdOf(held) || sessionIdOf(all[all.length - 1]);
						if (id) return id;
					}
				} catch {
					/* 换下一种形状 */
				}
				try {
					const snap = hook((s) => s);
					if (!snap || typeof snap !== "object") continue;
					const items = Array.isArray(snap)
						? snap
						: snap.items || snap.sessions || snap.list || snap.all || null;
					if (Array.isArray(items) && items.length > 0) {
						const current =
							snap.current || snap.active || snap.selected || snap.lastActive || snap.last || null;
						const id = sessionIdOf(current) || sessionIdOf(items[items.length - 1]);
						if (id) return id;
					}
					const loose =
						sessionIdOf(snap.current) || sessionIdOf(snap.active) || sessionIdOf(snap.lastActive);
					if (loose) return loose;
				} catch {
					/* 换下一个 hook */
				}
			}
			return null;
		}

		/* ------------------------------------------------------- Host 调用 */

		function errorOf(value, fallback) {
			return value && typeof value === "object" && typeof value.error === "string" && value.error
				? value.error
				: fallback;
		}

		/**
		 * 面板到 Host 的调用。两条通道，行为一致：
		 *
		 *   1. `fetch("/memory-refine/ui")` —— 首选。走 webServer 路由，不进命令总线，
		 *      所以会话日志里不会留下 command/run + command/done 那一对事件。
		 *   2. `ctx.remote.commands.execute(...)` —— 兜底。HTTP 路由没注册上
		 *      （webServer 缺席）、或请求被鉴权层挡下时用它，保证面板不会因为通道
		 *      不可用而彻底残废。代价是对话里会重新出现记录，所以一旦发生就在面板
		 *      顶部挂一条警告，而不是悄悄降级。
		 *
		 * 通道层失败才降级；业务错误（版本冲突、路径越界）照常往上抛，不降级 ——
		 * 那种情况下换通道重试不会变好，只会多留一条记录。
		 */
		function makeCall(ctx, sessionId) {
			async function callViaCommand(payload) {
				const line = BRIDGE + JSON.stringify(payload);
				const res = await ctx.remote.commands.execute(sessionId, line, []);
				if (!res || res.ok !== true) {
					throw new Error((res && res.error && res.error.message) || "宿主调用失败");
				}
				const execution = res.value;
				if (!execution) {
					throw new Error("宿主没有匹配到 /memory-refine 命令（插件可能还没有加载完）。");
				}
				const result = execution.result;
				if (!result || result.kind !== "success") {
					throw new Error((result && result.text) || "宿主返回了错误");
				}
				let parsed;
				try {
					parsed = JSON.parse(result.text || "null");
				} catch {
					throw new Error("宿主返回值不是 JSON：" + String(result.text).slice(0, 200));
				}
				if (!parsed || parsed.ok !== true) throw new Error("宿主返回的结构不符合预期");
				return parsed.data;
			}

			return async function call(payload) {
				if (!sessionId) {
					throw new Error("找不到可用会话。请先在左侧打开任意一个会话，再回到这个面板。");
				}
				const body = Object.assign({}, payload, { sessionId });

				let res;
				try {
					res = await fetch(HTTP_ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
				} catch (e) {
					// fetch 本身失败：协议桥不认这个路径，或者根本没连上。
					channel.warn =
						"面板通道连不上（" +
						String((e && e.message) || e) +
						"），已回退到命令通道 —— 对话里会重新出现 memory-refine 记录。";
					return callViaCommand(payload);
				}

				if (!res.ok) {
					// 尽量把宿主给的原因带出来，不然「403」三个字没法定位。
					let detail = "";
					try {
						const rejected = await res.json();
						if (rejected && typeof rejected.error === "string") detail = rejected.error;
					} catch {
						/* 没有 JSON body 就算了 */
					}
					channel.warn =
						"面板通道被拒绝（HTTP " +
						res.status +
						(detail ? " · " + detail : "") +
						"），已回退到命令通道 —— 对话里会重新出现 memory-refine 记录。";
					return callViaCommand(payload);
				}

				let parsed = null;
				try {
					parsed = await res.json();
				} catch {
					parsed = null;
				}
				if (!parsed || typeof parsed !== "object") {
					channel.warn = "面板通道返回了非 JSON 内容，已回退到命令通道。";
					return callViaCommand(payload);
				}
				if (parsed.ok !== true) throw new Error(errorOf(parsed, "宿主返回失败"));
				channel.warn = "";
				return parsed.data;
			};
		}

		/* ---------------------------------------------------------- 面板 */

		/* 面板的本地缓存：放在模块级，跨「切走再回来」的重新挂载依然有效。
		   走 HTTP 通道之后不再是「少留痕」的问题，但重取一次就多一次磁盘扫描，
		   所以策略不变：只有用户主动点「刷新」才作废重取。 */
		const panelCache = { sessionId: null, list: null, docs: new Map() };

		function Panel(props) {
			const sessionId = pickSessionId(props);
			const call = React.useMemo(() => makeCall(ctxRef.current, sessionId), [sessionId]);

			const usable = panelCache.sessionId === sessionId ? panelCache : null;
			const [home, setHome] = React.useState(usable && usable.list ? usable.list.home : "");
			const [files, setFiles] = React.useState(usable && usable.list ? usable.list.files : null);
			const [err, setErr] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [doc, setDoc] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [impOpen, setImpOpen] = React.useState(false);
			const [impTarget, setImpTarget] = React.useState("");
			const [impTitle, setImpTitle] = React.useState("");
			const [impText, setImpText] = React.useState("");
			const [showArchive, setShowArchive] = React.useState(false);
			const [delConfirm, setDelConfirm] = React.useState(false);
			const [cleanConfirm, setCleanConfirm] = React.useState(false);
			const [lastBackup, setLastBackup] = React.useState("");
			const [reloadConfirm, setReloadConfirm] = React.useState(false);

			// 就地改左栏某一条的元数据（读到/写入之后用），不再整表刷新。
			const patchFile = React.useCallback((path, patch) => {
				setFiles((prev) => {
					if (!Array.isArray(prev)) return prev;
					const next = prev.map((f) => (f.path === path ? Object.assign({}, f, patch) : f));
					if (panelCache.list && panelCache.list.files) panelCache.list.files = next;
					return next;
				});
			}, []);

			// force=true 只给「刷新」按钮用：作废缓存、真去重读磁盘。
			const load = React.useCallback(
				async (force) => {
					const sameSession = panelCache.sessionId === sessionId;
					if (!force && sameSession && panelCache.list) {
						setHome(panelCache.list.home);
						setFiles(panelCache.list.files);
						return;
					}
					if (force || !sameSession) {
						panelCache.sessionId = sessionId;
						panelCache.list = null;
						panelCache.docs.clear();
					}
					setBusy(true);
					setErr("");
					try {
						const data = await call({ action: "list" });
						const next = {
							home: data.home || "",
							files: Array.isArray(data.files) ? data.files : [],
						};
						panelCache.sessionId = sessionId;
						panelCache.list = next;
						setHome(next.home);
						setFiles(next.files);
					} catch (e) {
						setErr(String((e && e.message) || e));
					} finally {
						setBusy(false);
					}
				},
				[call, sessionId],
			);

			React.useEffect(() => {
				load(false);
			}, [load]);

			const open = React.useCallback(
				async (path, opts) => {
					const force = !!(opts && opts.force);
					setErr("");
					setNotice("");
					setDelConfirm(false);
					setReloadConfirm(false);
					if (!force) {
						const cached = panelCache.docs.get(path);
						if (cached) {
							setDoc(cached);
							setDraft(String(cached.text || ""));
							return;
						}
					}
					setBusy(true);
					try {
						const data = await call({ action: "read", path });
						panelCache.docs.set(data.path, data);
						setDoc(data);
						setDraft(String(data.text || ""));
						// 顺手把左栏这一条的版本/行数/大小对齐，省掉一次整表刷新。
						patchFile(data.path, { version: data.version, lines: data.lines, size: data.size });
					} catch (e) {
						setErr(String((e && e.message) || e));
					} finally {
						setBusy(false);
					}
				},
				[call, patchFile],
			);

			const save = React.useCallback(async () => {
				if (!doc) return;
				setBusy(true);
				setErr("");
				setNotice("");
				try {
					const out = await call({
						action: "write",
						path: doc.path,
						text: draft,
						expectedVersion: doc.version,
					});
					setNotice(
						"已写入 " + out.path + "：" + (out.created ? "新建 " : "") + out.version +
							" · +" + (out.added || 0) + "/-" + (out.removed || 0) + " 行" +
							(out.verified ? " · 读回核验通过" : " · ⚠ 读回核验失败，请立刻检查"),
					);
					const nextDoc = Object.assign({}, doc, {
						version: out.version,
						text: draft,
						lines: out.lines,
						size: out.size,
					});
					panelCache.docs.set(nextDoc.path, nextDoc);
					setDoc(nextDoc);
					// 这次改动留了一份备份。等他看过、说「这版没问题」，再把它删掉；
					// 一直不点就一直留着 —— 没确认过的东西不能替它做主丢掉。
					setLastBackup(out.backup || "");
					// 不整表刷新：写入的返回值已经带了新的版本/行数/大小，就地更新就行，
					// 免得保存一次又在会话里多留一条 list 记录。
					patchFile(out.path, { version: out.version, lines: out.lines, size: out.size });
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [call, doc, draft, patchFile]);

			// 磁盘上的版本可能被别人（模型 / 另一个窗口）改过，这时保存会被版本预检拦下。
			// 这个按钮从磁盘再读一次拿新版本号；有未保存的改动会先问一声。
			// 注意：这里不能引用下面的 `dirty`（它在 411 行才定义，会撞 TDZ），就地算一次。
			const reload = React.useCallback(() => {
				if (!doc) return;
				if (draft !== String(doc.text || "")) {
					setReloadConfirm(true);
					return;
				}
				panelCache.docs.delete(doc.path);
				open(doc.path, { force: true });
			}, [doc, draft, open]);

			const doReload = React.useCallback(() => {
				if (!doc) return;
				setReloadConfirm(false);
				panelCache.docs.delete(doc.path);
				open(doc.path, { force: true });
			}, [doc, open]);

			const doImport = React.useCallback(async () => {
				setBusy(true);
				setErr("");
				setNotice("");
				try {
					const out = await call({
						action: "import",
						target: impTarget,
						title: impTitle,
						text: impText,
						mode: "section",
					});
					setNotice(
						(out.fromPath
							? "已从 " + out.fromPath + " 读入 " + (out.sourceChars || 0) + " 字 · "
							: "") +
							"已导入 " + out.path + "：" + out.version +
							" · +" + (out.added || 0) + " 行" +
							(out.verified ? " · 读回核验通过" : " · ⚠ 读回核验失败"),
					);
					setImpOpen(false);
					setImpText("");
					setImpTitle("");
					// 导入改了文件内容：先把这条缓存作废，再只读它一次（不再整表 list）。
					panelCache.docs.delete(out.path);
					open(out.path);
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [call, impTarget, impTitle, impText, open]);

			// 删除也走三道闸：版本预检 → 备份 → 删后核验。注入层 AGENTS.md 由宿主直接拒绝。
			const doDelete = React.useCallback(async () => {
				if (!doc) return;
				setBusy(true);
				setErr("");
				setNotice("");
				try {
					const out = await call({ action: "delete", path: doc.path, expectedVersion: doc.version });
					panelCache.docs.delete(out.path);
					setFiles((prev) => {
						if (!Array.isArray(prev)) return prev;
						const next = prev.filter((f) => f.path !== out.path);
						if (panelCache.list) panelCache.list.files = next;
						return next;
					});
					setDoc(null);
					setDraft("");
					setDelConfirm(false);
					// 删除也会留一份备份，同样等他确认「这版没问题」再清。
					setLastBackup(out.backup || "");
					setNotice(
						"已删除 " + out.path + " · " + (out.removedBytes || 0) + "B" +
							" · 备份：" + out.backup +
							(out.gone ? " · 已核验文件不在" : " · ⚠ 文件还在，请立刻检查"),
					);
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [call, doc]);

			const doClean = React.useCallback(async () => {
				setBusy(true);
				setErr("");
				setNotice("");
				try {
					const out = await call({ action: "cleanScratch" });
					const kb = (Number(out.freed || 0) / 1024).toFixed(1);
					setCleanConfirm(false);
					setNotice(
						Number(out.removed || 0) === 0
							? "素材目录里没有可清理的文件（" + (out.dir || "") + "）"
							: "已清理 " + out.removed + " 个素材文件 · 释放 " + kb + "KB" +
								(out.kept ? " · 另有 " + out.kept + " 个不是本插件生成的文件没动" : "") +
								" · 目录：" + (out.dir || ""),
					);
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [call]);

			const doDropBackup = React.useCallback(async () => {
				if (!lastBackup) return;
				setBusy(true);
				setErr("");
				try {
					const out = await call({ action: "dropBackup", backup: lastBackup });
					setLastBackup("");
					setNotice(
						out.dropped
							? "已删掉这份备份（" + (out.bytes || 0) + "B）。正文没动。"
							: "那份备份已经不在了（可能之前删过）。",
					);
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [call, lastBackup]);

			const dirty = doc ? draft !== String(doc.text || "") : false;

			const item = (f) =>
				h(
					"li",
					{
						key: f.path,
						className: "mrf-item" + (doc && doc.path === f.path ? " mrf-item-on" : ""),
						onClick: () => open(f.path),
					},
					h("div", { className: "mrf-item-path" }, f.path),
					h(
						"div",
						{ className: "mrf-item-meta" },
						(LAYER_LABEL[f.layer] || f.layer) + " · " + f.size + "B · " + f.lines + " 行",
					),
					h("div", { className: "mrf-item-meta" }, f.version),
				);

			// 存档是旧账本，默认收起来，只把「活的」摆在眼前。
			const liveFiles = Array.isArray(files) ? files.filter((f) => f.layer !== "archive") : [];
			const archFiles = Array.isArray(files) ? files.filter((f) => f.layer === "archive") : [];
			const listRows =
				files === null
					? [h("li", { key: "__empty", className: "mrf-empty" }, busy ? "读取中…" : "还没有读取")]
					: files.length === 0
						? [h("li", { key: "__none", className: "mrf-empty" }, "没有找到记忆文件")]
						: [
								...liveFiles.map(item),
								archFiles.length
									? h(
											"li",
											{
												key: "__arch",
												className: "mrf-group-toggle",
												onClick: () => setShowArchive(!showArchive),
											},
											(showArchive ? "▾ 收起存档 (" : "▸ 显示存档 (") + archFiles.length + ")",
										)
									: null,
								...(showArchive ? archFiles.map(item) : []),
							];

			return h(
				"div",
				{ className: "mrf-root" },
				h(
					"div",
					{ className: "mrf-head" },
					h("h2", { className: "mrf-title" }, "记忆提炼"),
					h("span", { className: "mrf-home", title: home }, home || ""),
					h(
						"button",
						{
							className: "mrf-btn",
							type: "button",
							onClick: () => setCleanConfirm(!cleanConfirm),
							disabled: busy,
							title: "清掉会话工作区下 memory-refine-scratch/ 里本插件生成的素材（会先问一次）",
						},
						"清理素材…",
					),
					h(
						"button",
						{ className: "mrf-btn", type: "button", onClick: () => load(true), disabled: busy },
						"刷新",
					),
				),
				err ? h("div", { className: "mrf-msg mrf-err" }, err) : null,
				// 通道降级警告。channel 是模块级对象，不触发重渲染 —— 但每次调用都会
				// setBusy(true/false) 一次，渲染顺手就把它读出来了，不用额外的 state。
				channel.warn ? h("div", { className: "mrf-msg mrf-err" }, channel.warn) : null,
				notice ? h("div", { className: "mrf-msg mrf-notice" }, notice) : null,
				lastBackup
					? h(
							"div",
							{ className: "mrf-confirm" },
							h("span", null, "这次改动的备份还留着：" + lastBackup),
							h("span", { className: "mrf-spacer" }),
							h(
								"button",
								{ className: "mrf-btn mrf-btn-primary", type: "button", onClick: doDropBackup, disabled: busy },
								busy ? "处理中…" : "这版没问题，删掉备份",
							),
						)
					: null,
				cleanConfirm
					? h(
							"div",
							{ className: "mrf-confirm" },
							h("span", null, "清理素材：会删掉当前会话工作区下 memory-refine-scratch/ 里所有 material-*.md 与 tools-*.md，删了不能恢复。别的东西一概不动。"),
							h("span", { className: "mrf-spacer" }),
							h(
								"button",
								{ className: "mrf-btn mrf-btn-danger", type: "button", onClick: doClean, disabled: busy },
								busy ? "清理中…" : "确认清理",
							),
							h(
								"button",
								{ className: "mrf-btn", type: "button", onClick: () => setCleanConfirm(false), disabled: busy },
								"取消",
							),
						)
					: null,
				h(
					"div",
					{ className: "mrf-body" },
					h("ul", { className: "mrf-list" }, listRows),
					h(
						"div",
						{ className: "mrf-editor" },
						h(
							"div",
							{ className: "mrf-editor-head" },
							h(
								"span",
								{ className: "mrf-doc" },
								doc
									? doc.path + " · " + doc.size + "B · " + doc.lines + " 行 · " + doc.version + (dirty ? " · 未保存" : "")
									: "从左边选一个文件",
							),
							h("span", { className: "mrf-spacer" }),
							doc
								? h(
										"button",
										{
											className: "mrf-btn",
											type: "button",
											onClick: reload,
											disabled: busy,
											title: "从磁盘重新读一次（有未保存的改动时会先问你）",
										},
										"重新读取",
									)
								: null,
							doc && doc.path !== "AGENTS.md"
								? h(
										"button",
										{
											className: "mrf-btn mrf-btn-danger",
											type: "button",
											onClick: () => setDelConfirm(!delConfirm),
											disabled: busy || dirty,
											title: dirty ? "先保存或放弃未保存的改动" : "删除这个文件（会先备份到 memory-refine-backups/）",
										},
										"删除…",
									)
								: null,
							h(
								"button",
								{
									className: "mrf-btn",
									type: "button",
									onClick: () => setImpOpen(!impOpen),
									disabled: busy,
								},
								impOpen ? "收起导入" : "导入…",
							),
							h(
								"button",
								{
									className: "mrf-btn mrf-btn-primary",
									type: "button",
									onClick: save,
									disabled: busy || !doc || !dirty,
								},
								"保存",
							),
						),
						doc && delConfirm && doc.path !== "AGENTS.md"
							? h(
									"div",
									{ className: "mrf-confirm" },
									h(
										"span",
										null,
										"确定删除 " + doc.path + " 吗？" + doc.size + "B / " + doc.lines +
											" 行会先整份备份到 memory-refine-backups/，然后从磁盘删掉。",
									),
									h("span", { className: "mrf-spacer" }),
									h(
										"button",
										{ className: "mrf-btn mrf-btn-danger", type: "button", onClick: doDelete, disabled: busy },
										busy ? "删除中…" : "确认删除",
									),
									h(
										"button",
										{ className: "mrf-btn", type: "button", onClick: () => setDelConfirm(false), disabled: busy },
										"取消",
									),
								)
							: null,
						doc && reloadConfirm
							? h(
									"div",
									{ className: "mrf-confirm" },
									h(
										"span",
										null,
										"编辑框里还有没保存的改动。重新读取会用磁盘上的版本覆盖它，那些改动就没了。",
									),
									h("span", { className: "mrf-spacer" }),
									h(
										"button",
										{ className: "mrf-btn mrf-btn-danger", type: "button", onClick: doReload, disabled: busy },
										"确定丢掉重读",
									),
									h(
										"button",
										{ className: "mrf-btn", type: "button", onClick: () => setReloadConfirm(false), disabled: busy },
										"取消",
									),
								)
							: null,
						impOpen
							? h(
									"div",
									null,
									h(
										"div",
										{ className: "mrf-field" },
										h("span", { className: "mrf-label" }, "目标文件"),
										h("input", {
											className: "mrf-input",
											value: impTarget,
											placeholder: "如 memory/示例主题.md",
											onChange: (e) => setImpTarget(e.target.value),
										}),
										h("span", { className: "mrf-label" }, "章节标题"),
										h("input", {
											className: "mrf-input",
											value: impTitle,
											placeholder: "如 从旧笔记导入",
											onChange: (e) => setImpTitle(e.target.value),
										}),
									),
									h("textarea", {
										className: "mrf-text",
										style: { minHeight: "120px", marginTop: "8px" },
										value: impText,
										placeholder: "把要导入的旧记忆粘在这里，或者只填一个文件的绝对路径（如 D:\\旧笔记.md），然后按「导入」",
										onChange: (e) => setImpText(e.target.value),
									}),
									h(
										"div",
										{ className: "mrf-field", style: { marginTop: "8px" } },
										h("span", { className: "mrf-label" }, "导入会新起一个二级标题章节；写前自动备份，写后读回核验。"),
										h("span", { className: "mrf-spacer" }),
										h(
											"button",
											{
												className: "mrf-btn mrf-btn-primary",
												type: "button",
												onClick: doImport,
												disabled: busy || !impTarget.trim() || !impText.trim(),
											},
											"导入",
										),
									),
								)
							: null,
						doc
							? h("textarea", {
									className: "mrf-text",
									value: draft,
									spellCheck: false,
									onChange: (e) => setDraft(e.target.value),
								})
							: h("div", { className: "mrf-empty" }, "选一个文件就能在这里看和改。"),
					),
				),
			);
		}

		/* ------------------------------------------------ 侧边栏入口图标 */

		function PanelIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 18;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("path", { d: "M5.5 4.5h8.5l5 5v10H5.5z" }),
				h("path", { d: "M14 4.5v5h5" }),
				h("path", { d: "M8.5 13h7" }),
				h("path", { d: "M8.5 16.5h4.5" }),
			);
		}

		/* ---------------------------------------------------------- apply */

		let ctxRef = { current: null };
		const inject = ["slots", "remote", "remote.commands"];

		function apply(ctx) {
			ctxRef.current = ctx;
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{
								name: "sidebar.panellist",
								id: PANEL_KEY,
								order: 21,
								label: () => "记忆提炼",
							},
							PanelIcon,
						),
					),
				"memory-refine: sidebar entry",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PANEL_KEY,
							},
							Panel,
						),
					),
				"memory-refine: main panel",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
