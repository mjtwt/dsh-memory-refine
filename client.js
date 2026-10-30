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
			/* 记忆海：画布本身固定深海色（那是内容的一部分），周边 UI 跟主题走 */
			".mrs-root{display:flex;flex-direction:column;height:100%;min-height:0}",
			".mrs-bar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 16px 8px;flex-wrap:wrap}",
			".mrs-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.05em}",
			".mrs-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}",
			".mrs-note{font-size:11px;line-height:16px;padding:2px 9px;border-radius:20px;background:rgba(78,168,222,.13);border:.5px solid rgba(78,168,222,.3);color:#9fd0ee;white-space:nowrap}",
			".mrs-search{display:flex;align-items:center;gap:6px;margin-left:auto;padding:0 9px;height:28px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2)}",
			".mrs-search input{font:inherit;font-size:12px;border:0;background:transparent;color:var(--dsw-alias-label-primary);outline:none;width:140px}",
			".mrs-search input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".mrs-cnt{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:30px;text-align:right}",
			".mrs-legend{flex:0 0 auto;display:flex;gap:5px;flex-wrap:wrap;padding:0 16px 9px}",
			".mrs-lg{display:flex;align-items:center;gap:5px;font-size:11px;line-height:16px;padding:3px 9px;border-radius:20px;border:.5px solid var(--dsw-alias-border-l2);cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}",
			".mrs-lg:hover{border-color:var(--dsw-alias-label-tertiary)}",
			".mrs-lg em{font-style:normal;color:var(--dsw-alias-label-tertiary);font-size:10.5px}",
			".mrs-lg-off{opacity:.38}",
			".mrs-lg i{width:7px;height:7px;border-radius:50%;box-shadow:0 0 7px currentColor;flex:0 0 auto}",
			".mrs-stage{display:flex;flex:1 1 auto;min-height:0;margin:0 16px 14px;border-radius:10px;overflow:hidden;background:#04121c}",
			".mrs-canvas-wrap{position:relative;flex:1 1 auto;min-width:0}",
			".mrs-canvas-wrap canvas{display:block;width:100%;height:100%;cursor:grab}",
			".mrs-canvas-wrap canvas:active{cursor:grabbing}",
			".mrs-tip{position:absolute;z-index:3;pointer-events:none;max-width:250px;padding:6px 9px;border-radius:7px;background:rgba(8,20,32,.95);border:.5px solid rgba(110,170,215,.3);font-size:11.5px;line-height:1.6;color:#cfe1ee;box-shadow:0 8px 30px rgba(0,0,0,.5)}",
			".mrs-tip em{display:block;font-style:normal;color:#6e8699;font-size:10px;margin-top:2px}",
			".mrs-detail{position:relative;flex:0 0 380px;display:flex;flex-direction:column;min-width:0;padding:16px 16px 12px;background:rgba(6,18,28,.96);border-left:.5px solid rgba(110,170,215,.2);color:#c9dced}",
			".mrs-detail h3{margin:0 0 10px;font-size:13px;font-weight:600;line-height:1.6;color:#e6f1f9;padding-right:20px}",
			".mrs-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:10.5px;color:#6f879b;margin-bottom:10px}",
			".mrs-meta span{border:.5px solid rgba(110,170,215,.22);border-radius:20px;padding:1px 8px}",
			".mrs-body{flex:1 1 auto;overflow:auto;font-size:12px;line-height:1.9;white-space:pre-wrap;word-break:break-word;color:#b8ccdc}",
			".mrs-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px;flex:0 0 auto}",
			".mrs-tag{font-size:10.5px;color:#7fa6c2;border:.5px solid rgba(110,170,215,.2);border-radius:20px;padding:1px 7px;cursor:pointer}",
			".mrs-tag:hover{color:#c9e2f2;border-color:rgba(110,190,240,.5)}",
			".mrs-foot{flex:0 0 auto;margin-top:10px;padding-top:8px;border-top:.5px solid rgba(110,170,215,.14);display:flex;align-items:center;gap:8px;font-size:10.5px;color:#4f6578}",
			".mrs-x{position:absolute;top:12px;right:12px;border:0;background:none;color:#5e7689;font-size:17px;line-height:1;cursor:pointer;padding:0 4px;border-radius:5px}",
			".mrs-x:hover{color:#d5e6f2;background:rgba(90,150,200,.12)}",
			".mrs-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5b7286;font-size:12px}",
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
		/** 记忆海的入口。故意做成**另一个**面板，不塞进记忆提炼里：
		 *  一个在改文件、一个在看结构，两件事的心智不一样；分开还能各自吃满整宽。 */
		const SEA_KEY = "memory-refine-sea";
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

		/* ---------------------------------------------------------- 记忆海 */

		/*
		 * 一片按「海域 × 时间」铺开的记忆图。
		 *
		 * 数据在宿主侧（sea.js）算好，这里只负责画 —— 面板和文件读写完全分开，
		 * 海的画面不写任何东西。
		 *
		 * 三件事值得写下来，因为都不是显然的：
		 *
		 * 1. **纵向按日期排名铺，不按日期线性铺。** 118 条里有 100 条挤在最近
		 *    一个月，线性映射会把整片海压成屏幕中间一条线；排名映射保序、不保
		 *    尺度，代价是纵轴不等距。
		 * 2. **画布尺寸跟着容器，不跟 window。** 这是面板里的一块，不是整页。
		 * 3. **画布固定深海色，不跟亮色主题走。** 深色是这张图的语义（越深越旧），
		 *    亮色主题下它就是一块"观察窗"，周围 UI 才跟主题变量。
		 */

		const SEA_TAU = Math.PI * 2;
		const SEA_WORLD = { w: 1560, h: 1000 };
		const SEA_ARCHIVE = { id: "archive", label: "沉积层", zone: "海床", color: "#4a5c6e" };

		/** '#4ea8de' → '78,168,222'，颜色要在 rgba() 里带透明度用。 */
		function seaRgb(hex) {
			const raw = String(hex || "#7ba7c4").replace("#", "");
			const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
			const n = parseInt(full, 16);
			if (!Number.isFinite(n)) return "123,167,196";
			return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
		}

		/** 确定性随机：同一份数据每次打开长一个样，不会跳。 */
		function seaRand(a) {
			return function () {
				a |= 0;
				a = (a + 0x6d2b79f5) | 0;
				let t = Math.imul(a ^ (a >>> 15), 1 | a);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}

		/**
		 * 一条记忆的稳定身份，取 FNV-1a 32 位的十六进制。
		 *
		 * 为什么不在本地存原文当钥匙：`key` 是正文前 40 字，那是记忆本身。
		 * 落进 localStorage 就等于在浏览器存储里留了一份正文碎片 —— 这插件
		 * 一条正文都不外传，也就不该在本地多留一份「够认出来」的残片。
		 * 8 个字符的哈希只够做同一性判断，认不出说的是什么。
		 */
		function seaKeyHash(key) {
			let h = 0x811c9dc5;
			const s = String(key || "");
			for (let i = 0; i < s.length; i++) {
				h ^= s.charCodeAt(i);
				h = Math.imul(h, 0x01000193);
			}
			return (h >>> 0).toString(16).padStart(8, "0");
		}

		/** 上一次看这片海时记下的东西：指纹 + 每条记忆的哈希。**不含正文**。 */
		const SEA_BASE_KEY = "memory-refine-sea-base";
		function seaReadBase(dim) {
			try {
				const all = JSON.parse(window.localStorage.getItem(SEA_BASE_KEY) || "{}");
				const one = all && all[dim];
				if (!one || !Array.isArray(one.h)) return null;
				return one;
			} catch (e) {
				return null;
			}
		}
		function seaWriteBase(dim, base) {
			try {
				const all = JSON.parse(window.localStorage.getItem(SEA_BASE_KEY) || "{}");
				all[dim] = base;
				window.localStorage.setItem(SEA_BASE_KEY, JSON.stringify(all));
			} catch (e) {
				// 存不下（隐私模式、配额满）就算了 —— 大不了下次不提示「新增了哪几条」
			}
		}

		function createSeaView(canvas, data, hooks) {
			const ctx = canvas.getContext("2d");
			const emitHover = (hooks && hooks.onHover) || function () {};
			const emitSelect = (hooks && hooks.onSelect) || function () {};
			if (!ctx) {
				return { destroy() {}, setQuery: () => 0, setLayerVisible() {}, fit() {}, reset() {} };
			}

			const rnd = seaRand(20261030);
			// 这次「新长出来」的记忆（哈希集合）与出生时刻。没有基线的第一次打开是空的。
			const fresh = (hooks && hooks.fresh) || null;
			const bornAt = Date.now();
			const nodes = data.nodes.map((n, i) => ({
				...n,
				idx: i,
				x: 0,
				y: 0,
				vx: 0,
				vy: 0,
				fx: 0,
				fy: 0,
				r: 2.9 + Math.min(Math.sqrt(n.chars) * 0.24, 6.4),
				on: true,
				hk: seaKeyHash(n.key),
				phase: (i * 2.399) % SEA_TAU,
			}));
			const edges = data.edges.map((e) => ({ ...e }));

			const layers = data.layers.slice();
			const layerOrder = layers.filter((l) => l.id !== "archive").map((l) => l.id);
			const visible = new Set(layers.map((l) => l.id));
			const colorOf = {};
			const labelOf = {};
			for (const l of layers) {
				colorOf[l.id] = l.color;
				labelOf[l.id] = l.label;
			}
			if (!colorOf.archive) {
				colorOf.archive = SEA_ARCHIVE.color;
				labelOf.archive = SEA_ARCHIVE.label;
			}

			// 时间 → 深度：按日期排名。见文件头第 1 条。
			const byDate = nodes
				.filter((n) => !n.archived)
				.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
			byDate.forEach((n, i) => {
				n.rank = byDate.length > 1 ? i / (byDate.length - 1) : 1;
			});

			// 海域的宽度按节点数分配，不是等分。
			//
			// 等分的时候：49 条的「我们的线」和 8 条的「项目」占一样宽 —— 前者挤成
			// 一团、后者孤零零挂在右边，中间留一大片空。反过来按条数直接分也不行：
			// 49 : 8 是 6 倍，项目会被压成一条缝。所以开根压缩，6 倍变成 2.4 倍。
			const SEA_PAD_X = 120
			const SEA_GAP = 26
			const anchors = {}
			const layerWidth = {}
			{
				const counts = {}
				for (const n of nodes) if (!n.archived) counts[n.layer] = (counts[n.layer] || 0) + 1
				const weights = layerOrder.map((id) => Math.sqrt(Math.max(counts[id] || 0, 4)))
				const sumW = weights.reduce((a, b) => a + b, 0) || 1
				const avail = SEA_WORLD.w - SEA_PAD_X * 2 - SEA_GAP * (layerOrder.length - 1)
				let cursor = -SEA_WORLD.w / 2 + SEA_PAD_X
				layerOrder.forEach((id, i) => {
					const w = (avail * weights[i]) / sumW
					layerWidth[id] = w
					anchors[id] = { x: cursor + w / 2, y: 0, w }
					cursor += w + SEA_GAP
				})
			}
			anchors.archive = { x: 0, y: SEA_WORLD.h / 2 - 40, w: SEA_WORLD.w * 0.86 };

			const cam = { x: 0, y: 0, s: 1 };
			let W = 0;
			let H = 0;
			let DPR = 1;

			const state = { hover: null, sel: null, query: "", dragging: false, lastX: 0, lastY: 0, moved: 0, t: 0 };
			const matches = new Set();

			const w2s = (x, y) => ({ x: (x - cam.x) * cam.s + W / 2, y: (y - cam.y) * cam.s + H / 2 });
			const s2w = (x, y) => ({ x: (x - W / 2) / cam.s + cam.x, y: (y - H / 2) / cam.s + cam.y });
			const floatX = (n) => Math.sin(state.t * 0.0006 + n.phase) * 3.2;
			const floatY = (n) => Math.cos(state.t * 0.0005 + n.phase * 1.3) * 2.6;

			/* 布局与物理 */

			function initPositions() {
				for (const n of nodes) {
					if (n.archived) {
						// 沉积层铺在海床，不按日期走 —— 它们是旧快照，只有模糊的时间
						n.tx = (rnd() - 0.5) * 1180;
						n.ty = SEA_WORLD.h / 2 - 30 + (rnd() - 0.5) * 110;
					} else {
						const a = anchors[n.layer] || { x: 0, y: 0 };
						// 散布范围跟着这块海域自己的宽度走（见上面按节点数分配）
						const bandW = (a.w || 200) * 0.78;
						const rank = n.rank === undefined ? 0.5 : n.rank;
						n.tx = a.x + (rnd() - 0.5) * bandW;
						n.ty = (0.5 - rank) * SEA_WORLD.h * 0.88 + (rnd() - 0.5) * 80;
					}
					n.x = n.tx + (rnd() - 0.5) * 520;
					n.y = n.ty + (rnd() - 0.5) * 320;
					n.vx = 0;
					n.vy = 0;
				}
			}

			function step(alpha) {
				const REP = 900;
				const SPRING = 0.008;
				const CENTER = 0.115;
				const DAMP = 0.82;
				const act = nodes.filter((n) => n.on);
				for (const n of act) {
					n.fx = 0;
					n.fy = 0;
				}
				for (let i = 0; i < act.length; i++) {
					const a = act[i];
					const ma = a.archived ? 0.3 : 1;
					for (let j = i + 1; j < act.length; j++) {
						const b = act[j];
						let dx = a.x - b.x;
						let dy = a.y - b.y;
						let d2 = dx * dx + dy * dy;
						if (d2 < 1) {
							dx = (rnd() - 0.5) * 2;
							dy = (rnd() - 0.5) * 2;
							d2 = 1;
						}
						if (d2 > 300 * 300) continue;
						const f = (REP / d2) * ma * (b.archived ? 0.3 : 1);
						const d = Math.sqrt(d2);
						a.fx += (dx / d) * f;
						a.fy += (dy / d) * f;
						b.fx -= (dx / d) * f;
						b.fy -= (dy / d) * f;
					}
				}
				for (const e of edges) {
					const a = nodes[e.a];
					const b = nodes[e.b];
					if (!a || !b || !a.on || !b.on) continue;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const d = Math.hypot(dx, dy) || 1;
					// e.w 现在是共享词的 idf 之和（约 3–20），不是旧的「共享了几词」（1–4）。
					// 系数从 0.3 降到 0.04，否则一根强边会把两颗光拽到一起。
					const f = (d - 60) * SPRING * (1 + Math.min(e.w, 16) * 0.04);
					a.fx += (dx / d) * f;
					a.fy += (dy / d) * f;
					b.fx -= (dx / d) * f;
					b.fy -= (dy / d) * f;
				}
				for (const n of act) {
					n.fx += (n.tx - n.x) * CENTER;
					n.fy += (n.ty - n.y) * CENTER * 1.25;
					n.vx = (n.vx + n.fx * alpha) * DAMP;
					n.vy = (n.vy + n.fy * alpha) * DAMP;
					n.x += n.vx;
					n.y += n.vy;
				}
			}

			function fit() {
				const live = nodes.filter((n) => !n.archived && n.on);
				const use = live.length ? live : nodes;
				if (!use.length) return;
				let x0 = Infinity;
				let x1 = -Infinity;
				let y0 = Infinity;
				let y1 = -Infinity;
				for (const n of use) {
					x0 = Math.min(x0, n.tx);
					x1 = Math.max(x1, n.tx);
					y0 = Math.min(y0, n.ty);
					y1 = Math.max(y1, n.ty);
				}
				const bw = Math.max(x1 - x0, 200);
				const bh = Math.max(y1 - y0, 200);
				cam.s = Math.max(0.3, Math.min(1.25, Math.min(W / (bw + 220), H / (bh + 120))));
				cam.x = (x0 + x1) / 2;
				cam.y = (y0 + y1) / 2;
			}

			/* 海洋雪 */
			const snow = [];
			for (let i = 0; i < 90; i++) {
				snow.push({
					x: rnd(),
					y: rnd(),
					r: 0.4 + rnd() * 1.2,
					s: 0.06 + rnd() * 0.22,
					o: 0.05 + rnd() * 0.2,
					p: rnd() * SEA_TAU,
				});
			}

			/* 绘制 */

			function draw() {
				state.t += 16;

				const bg = ctx.createLinearGradient(0, 0, 0, H);
				bg.addColorStop(0, "#08202f");
				bg.addColorStop(0.28, "#04141f");
				bg.addColorStop(0.68, "#020b13");
				bg.addColorStop(1, "#01060b");
				ctx.fillStyle = bg;
				ctx.fillRect(0, 0, W, H);

				const glow = ctx.createRadialGradient(W * 0.5, -H * 0.28, 20, W * 0.5, -H * 0.28, H * 0.95);
				glow.addColorStop(0, "rgba(96,166,214,.16)");
				glow.addColorStop(0.45, "rgba(56,116,160,.05)");
				glow.addColorStop(1, "rgba(0,0,0,0)");
				ctx.fillStyle = glow;
				ctx.fillRect(0, 0, W, H);

				for (const s of snow) {
					s.y += (s.s / H) * 0.55;
					s.x += Math.sin(state.t * 0.0004 + s.p) * 0.00016;
					if (s.y > 1) {
						s.y = 0;
						s.x = Math.random();
					}
					ctx.beginPath();
					ctx.arc(s.x * W, s.y * H, s.r, 0, SEA_TAU);
					ctx.fillStyle = "rgba(180,215,240," + s.o * (0.55 + 0.45 * Math.sin(state.t * 0.001 + s.p)) + ")";
					ctx.fill();
				}

				// 海域：一块很淡的体块光 + 列名，让每个区域有"水域"的实感
				ctx.save();
				ctx.font = '600 10.5px -apple-system,"PingFang SC",sans-serif';
				ctx.textAlign = "center";
				for (const id of layerOrder) {
					if (!visible.has(id)) continue;
					const a = anchors[id];
					const head = w2s(a.x, -SEA_WORLD.h * 0.46 - 42);
					const gr = ctx.createRadialGradient(head.x, head.y + 230, 12, head.x, head.y + 230, 250 * cam.s + 90);
					const rr = seaRgb(colorOf[id]);
					gr.addColorStop(0, "rgba(" + rr + ",.075)");
					gr.addColorStop(0.55, "rgba(" + rr + ",.026)");
					gr.addColorStop(1, "rgba(" + rr + ",0)");
					ctx.fillStyle = gr;
					ctx.fillRect(head.x - 400 * cam.s, head.y - 60, 800 * cam.s, 700 * cam.s);
					ctx.fillStyle = "rgba(158,203,235,.42)";
					ctx.fillText(labelOf[id] || id, head.x, head.y);
					ctx.strokeStyle = "rgba(120,170,210,.12)";
					ctx.lineWidth = 0.5;
					ctx.beginPath();
					ctx.moveTo(head.x - 46, head.y + 8);
					ctx.lineTo(head.x + 46, head.y + 8);
					ctx.stroke();
				}
				ctx.restore();

				const sel = state.sel;

				// 连线
				const NO_DASH = [];
				for (const e of edges) {
					const a = nodes[e.a];
					const b = nodes[e.b];
					if (!a || !b || !a.on || !b.on) continue;
					const pa = w2s(a.x + floatX(a), a.y + floatY(a));
					const pb = w2s(b.x + floatX(b), b.y + floatY(b));
					const isSel = sel && (sel.idx === e.a || sel.idx === e.b);
					const isHit = state.query && matches.has(e.a) && matches.has(e.b);
					// 搜索时只留跟命中点有关的线。363 条线每条 5% 不透明度叠起来，
					// 就是一层盖住画面的灰雾 —— 点淡出了，线没淡出，等于白淡。
					if (state.query && !isSel && !isHit) continue;
					// 距离衰减：**只对同海域的线**。挨着的两条记忆该看得见绳，隔着大半片
					// 海域的两条只该是背景里一根丝。世界距离 120 以内算「贴着」，740 以外淡到底。
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const far = Math.min(Math.max((Math.sqrt(dx * dx + dy * dy) - 120) / 620, 0), 1);
					// 跨海域的线不按距离淡 —— 有人提过，提得对：跨类本来就远，
					// 用距离当衰减，等于把「不同海域之间有牵扯」这件事全杀掉了，而它恰恰
					// 是最稀有的信息。所以跨类改用一个**不看距离**的固定下限，只用权重分级。
					// 但不能全都同亮度：100 条等亮的线叠回去，就是刚花力气去掉的那层雾。
					const cross = a.layer !== b.layer;
					const wNorm = Math.min(e.w / 6, 1);
					// 权重按 idf 和算（约 3–20），除以 6 封顶 → 透明度落在 0.05–0.17，
					// 跟原来 1–3 词的尺度视觉上大致对齐，但强弱差得更开。
					const base = isSel
						? 0.5
						: isHit
							? 0.34
							: cross
								? 0.085 + wNorm * 0.09
								: (0.05 + wNorm * 0.12) * (1 - far * 0.6);
					ctx.strokeStyle = isSel
						? "rgba(150,215,255,.55)"
						: isHit
							? "rgba(130,200,245,.4)"
							: "rgba(110,165,205," + base + ")";
					// 跨类的线用线宽补一点存在感（它已经改走虚线，墨量本来就少一半）；
					// 同类的线仍是远细近粗，像手能摸到的绳。
					ctx.lineWidth = isSel || isHit ? 1.15 : cross ? 0.8 + wNorm * 0.45 : 0.65 + (1 - far) * 0.45;
					// 跨海域的线走虚线 —— 它们是「两个水域之间的牵扯」，不是同带相邻。
					// 缩得太小时虚点会碎成噪点，干脆退回实线。
					const dash = cross && !isSel && !isHit && cam.s > 0.5;
					if (dash) ctx.setLineDash([3.5, 6]);
					ctx.beginPath();
					ctx.moveTo(pa.x, pa.y);
					ctx.quadraticCurveTo((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + 12, pb.x, pb.y);
					ctx.stroke();
					if (dash) ctx.setLineDash(NO_DASH);
				}

				// 节点：按时间先后叠，新的压在上面
				const order = nodes.slice().sort((a, b) => a.date.localeCompare(b.date));
				for (const n of order) {
					if (!n.on) continue;
					const p = w2s(n.x + floatX(n), n.y + floatY(n));
					if (p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) continue;

					const rgb = seaRgb(colorOf[n.layer]);
					const alpha = (state.query ? (matches.has(n.idx) ? 1 : 0.1) : 1) * (n.archived ? 0.62 : 1);
					const isSel = sel && sel.idx === n.idx;
					const isHov = state.hover && state.hover.idx === n.idx;
					// 这次新长出来的那条：先由小长大，再散一圈涟漪，让「海变了」自己说话，
					// 不必去顶栏找一行字。不新的一律 age = +∞，所有分支都走原来的样子。
					const age = fresh && fresh.has(n.hk) ? Date.now() - bornAt : 1e9;
					const grow = age < 520 ? 0.25 + 0.75 * (age / 520) : 1;
					const r = n.r * cam.s * (isSel ? 1.9 : isHov ? 1.5 : 1) * grow;

					if (age < 2400) {
						const k = age / 2400;
						ctx.beginPath();
						ctx.arc(p.x, p.y, r + 8 + k * Math.max(r * 5.5, 30), 0, SEA_TAU);
						ctx.strokeStyle = "rgba(" + rgb + "," + (1 - k) * 0.45 + ")";
						ctx.lineWidth = 1.2;
						ctx.stroke();
					}

					// 搜索时没命中的点降到 0.1，光晕就别画了 —— 一层层淡淡的径向渐变
					// 叠在一起会糊成一片雾，比不画还脏。
					if (alpha > 0.15) {
						const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * (isSel ? 7 : 4.6));
						g.addColorStop(0, "rgba(" + rgb + "," + 0.34 * alpha + ")");
						g.addColorStop(0.35, "rgba(" + rgb + "," + 0.1 * alpha + ")");
						g.addColorStop(1, "rgba(" + rgb + ",0)");
						ctx.fillStyle = g;
						ctx.beginPath();
						ctx.arc(p.x, p.y, r * (isSel ? 7 : 4.6), 0, SEA_TAU);
						ctx.fill();
					}

					ctx.beginPath();
					ctx.arc(p.x, p.y, Math.max(r, 1.1), 0, SEA_TAU);
					ctx.fillStyle = "rgba(" + rgb + "," + 0.92 * alpha + ")";
					ctx.fill();
					ctx.beginPath();
					ctx.arc(p.x, p.y, Math.max(r * 0.42, 0.6), 0, SEA_TAU);
					ctx.fillStyle = "rgba(235,248,255," + 0.8 * alpha + ")";
					ctx.fill();

					// 标签只在真放大（1.05 倍以上）或 hover/选中/搜索命中时出。默认视野下
					// 118 个标签会糊成一片 —— 面板比全屏窄，跟原型的阈值不是一回事。
					if (isSel || isHov || (state.query && matches.has(n.idx)) || (cam.s > 1.05 && !n.archived)) {
						ctx.font = '11px -apple-system,"PingFang SC",sans-serif';
						ctx.textAlign = "left";
						ctx.fillStyle = "rgba(198,220,236," + 0.42 * alpha + ")";
						ctx.fillText(String(n.headline).slice(0, 13), p.x + r + 6, p.y + 3.5);
					}
				}

				// 深度刻度：只标两头。纵轴是排名不是等距，中间的刻度会撒谎。
				ctx.save();
				ctx.font = '10px -apple-system,"PingFang SC",sans-serif';
				ctx.textAlign = "right";
				ctx.fillStyle = "rgba(130,168,196,.42)";
				ctx.fillText("海面 · " + (data.range.to || ""), W - 12, 16);
				ctx.fillText("海床 · " + (data.range.from || ""), W - 12, H - 10);
				ctx.restore();
			}

			/* 交互 */

			function pick(mx, my) {
				let best = null;
				let bestD = 1e9;
				let bestP = null;
				for (const n of nodes) {
					if (!n.on) continue;
					const p = w2s(n.x + floatX(n), n.y + floatY(n));
					const r = Math.max(n.r * cam.s + 7, 11);
					const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
					if (d < r * r && d < bestD) {
						bestD = d;
						best = n;
						bestP = p;
					}
				}
				state.hover = best;
				canvas.style.cursor = best ? "pointer" : state.dragging ? "grabbing" : "grab";
				emitHover(
					best && bestP
						? {
								headline: best.headline,
								date: best.date,
								layer: best.layer,
								chars: best.chars,
								sx: bestP.x,
								sy: bestP.y,
							}
						: null,
				);
				return best;
			}

			const local = (e) => {
				const rect = canvas.getBoundingClientRect();
				return { x: e.clientX - rect.left, y: e.clientY - rect.top };
			};

			const onDown = (e) => {
				state.dragging = true;
				state.lastX = e.clientX;
				state.lastY = e.clientY;
				state.moved = 0;
				canvas.style.cursor = "grabbing";
			};
			const onUp = () => {
				state.dragging = false;
				canvas.style.cursor = state.hover ? "pointer" : "grab";
			};
			const onMove = (e) => {
				if (state.dragging) {
					const dx = e.clientX - state.lastX;
					const dy = e.clientY - state.lastY;
					state.moved += Math.abs(dx) + Math.abs(dy);
					cam.x -= dx / cam.s;
					cam.y -= dy / cam.s;
					state.lastX = e.clientX;
					state.lastY = e.clientY;
					return;
				}
				const p = local(e);
				pick(p.x, p.y);
			};
			const onWheel = (e) => {
				e.preventDefault();
				const rect = canvas.getBoundingClientRect();
				const before = s2w(e.clientX - rect.left, e.clientY - rect.top);
				cam.s = Math.min(Math.max(cam.s * Math.exp(-e.deltaY * 0.0013), 0.3), 3);
				const after = s2w(e.clientX - rect.left, e.clientY - rect.top);
				cam.x += before.x - after.x;
				cam.y += before.y - after.y;
			};
			const onDbl = () => fit();
			const onClick = (e) => {
				if (state.moved > 5) return;
				const p = local(e);
				const hit = pick(p.x, p.y);
				state.sel = hit;
				// 选中之后收起悬停气泡 —— 两个浮层叠在一起会互相盖住
				state.hover = null;
				emitHover(null);
				emitSelect(hit ? { ...hit, color: colorOf[hit.layer] || SEA_ARCHIVE.color } : null);
			};
			const onLeave = () => {
				state.hover = null;
				emitHover(null);
			};

			canvas.addEventListener("mousedown", onDown);
			window.addEventListener("mouseup", onUp);
			canvas.addEventListener("mousemove", onMove);
			canvas.addEventListener("mouseleave", onLeave);
			canvas.addEventListener("wheel", onWheel, { passive: false });
			canvas.addEventListener("dblclick", onDbl);
			canvas.addEventListener("click", onClick);

			/* 尺寸与循环 */

			let raf = 0;
			let warm = 0;
			const WARM = 260;

			function resize() {
				const host = canvas.parentElement;
				const rect = host ? host.getBoundingClientRect() : { width: 0, height: 0 };
				W = Math.max(40, Math.round(rect.width));
				H = Math.max(40, Math.round(rect.height));
				DPR = Math.min(window.devicePixelRatio || 1, 2);
				canvas.width = Math.round(W * DPR);
				canvas.height = Math.round(H * DPR);
				ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
			}

			function loop() {
				if (warm < WARM) {
					step(Math.max(0.35, 1 - warm / WARM));
					warm++;
				}
				draw();
				raf = requestAnimationFrame(loop);
			}

			let ro = null;
			resize();
			initPositions();
			if (typeof ResizeObserver === "function") {
				ro = new ResizeObserver(() => {
					const prevW = W;
					resize();
					// 只在宽度明显变了才重新取景（开/关详情面板正好是这种）。窗口抖动
					// 或高度微调不该把用户手动平移的位置弹回去。
					if (warm >= WARM && Math.abs(W - prevW) > 24) fit();
				});
				if (canvas.parentElement) ro.observe(canvas.parentElement);
			}
			fit();
			loop();

			/* 对外 */

			function applyVisibility() {
				for (const n of nodes) n.on = visible.has(n.archived ? "archive" : n.layer);
			}

			function computeMatches() {
				matches.clear();
				if (!state.query) return 0;
				const kw = state.query.toLowerCase();
				for (const n of nodes) {
					if (!n.on) continue;
					if (String(n.text).toLowerCase().includes(kw) || (n.tags || []).some((t) => t.includes(kw))) {
						matches.add(n.idx);
					}
				}
				return matches.size;
			}

			return {
				destroy() {
					if (raf) cancelAnimationFrame(raf);
					raf = 0;
					canvas.removeEventListener("mousedown", onDown);
					window.removeEventListener("mouseup", onUp);
					canvas.removeEventListener("mousemove", onMove);
					canvas.removeEventListener("mouseleave", onLeave);
					canvas.removeEventListener("wheel", onWheel);
					canvas.removeEventListener("dblclick", onDbl);
					canvas.removeEventListener("click", onClick);
					if (ro) ro.disconnect();
				},
				setQuery(v) {
					state.query = String(v || "").trim();
					return computeMatches();
				},
				setLayerVisible(id, on) {
					if (on) visible.add(id);
					else visible.delete(id);
					applyVisibility();
					return computeMatches();
				},
				fit,
				reset() {
					visible.clear();
					for (const l of layers) visible.add(l.id);
					applyVisibility();
					initPositions();
					warm = 0;
					fit();
				},
			};
		}



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

		/* ---------------------------------------------------------- 记忆海面板 */

		/** 左边那一栏的图标：三道水波加一颗光。 */
		function SeaIcon(props) {
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
					"aria-hidden": "true",
				},
				h("path", { d: "M3 8.5c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" }),
				h("path", { d: "M3 13c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" }),
				h("path", { d: "M3 17.5c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" }),
				h("circle", { cx: "12", cy: "13", r: "1.6", fill: "currentColor", stroke: "none" }),
			);
		}

		function SeaPanel(props) {
			const sessionId = pickSessionId(props);
			const call = React.useMemo(() => makeCall(ctxRef.current, sessionId), [sessionId]);

			const [data, setData] = React.useState(null);
			const [err, setErr] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [deep, setDeep] = React.useState(false);
			const [sel, setSel] = React.useState(null);
			const [hover, setHover] = React.useState(null);
			const [query, setQuery] = React.useState("");
			const [hits, setHits] = React.useState(0);
			const [off, setOff] = React.useState(function () {
				return new Set();
			});
			const [copied, setCopied] = React.useState("");
			/** 这次打开比上次多了/少了什么。空串＝没变化，也＝第一次打开。 */
			const [note, setNote] = React.useState("");
			/** 这次新出现的几条（哈希集合），交给画布做淡入和涟漪。
			 *  走 ref 不走 state：视图只在 data 换的时候重建，刷新标记不该多触发一轮。 */
			const freshRef = React.useRef(null);
			const canvasRef = React.useRef(null);
			const viewRef = React.useRef(null);

			const load = React.useCallback(
				async function (withArchive) {
					setBusy(true);
					setErr("");
					try {
						const d = await call({ action: "sea", withArchive: !!withArchive });
						if (!d || !Array.isArray(d.nodes)) throw new Error("没有取到记忆数据");

						// 「自动更新」就落在这几行：数据永远是刚取的最新一份，
						// 这里只负责跟上次那份对一对，好让新长出来的那几条能被看见。
						const dim = withArchive ? "deep" : "shallow";
						const hashes = d.nodes.map(function (n) {
							return seaKeyHash(n.key);
						});
						const base = seaReadBase(dim);
						const added = new Set();
						let gone = 0;
						if (base && base.digest !== d.digest) {
							const had = new Set(base.h || []);
							hashes.forEach(function (k) {
								if (!had.has(k)) added.add(k);
							});
							const now = new Set(hashes);
							(base.h || []).forEach(function (k) {
								if (!now.has(k)) gone++;
							});
						}
						if (added.size || gone) {
							const bits = [];
							if (added.size) bits.push("新长出来 " + added.size + " 条");
							if (gone) bits.push("沉下去 " + gone + " 条");
							setNote(bits.join(" · "));
						} else if (base && base.digest && base.digest !== d.digest) {
							// 文件动过、但条目的开头一个字都没变 —— 是内容被改了
							setNote("有记忆被改过");
						} else {
							setNote("");
						}
						seaWriteBase(dim, { digest: d.digest, h: hashes, at: Date.now() });
						freshRef.current = added;

						setData(d);
						setSel(null);
						setQuery("");
						setOff(new Set());
					} catch (e) {
						setErr(String((e && e.message) || e));
					} finally {
						setBusy(false);
					}
				},
				[call],
			);

			React.useEffect(
				function () {
					load(false);
				},
				[load],
			);

			// 视图绑定在 data 上：换一份数据就重建一个，不手动清画布
			React.useEffect(
				function () {
					const canvas = canvasRef.current;
					if (!data || !canvas) return undefined;
					const view = createSeaView(canvas, data, {
						onSelect: setSel,
						onHover: setHover,
						fresh: freshRef.current,
					});
					viewRef.current = view;
					return function () {
						viewRef.current = null;
						view.destroy();
					};
				},
				[data],
			);

			React.useEffect(
				function () {
					const v = viewRef.current;
					if (v) setHits(v.setQuery(query));
				},
				[query, data],
			);

			const labelOfLayer = function (id) {
				const hit = ((data && data.layers) || []).find(function (l) {
					return l.id === id;
				});
				return (hit && hit.label) || id;
			};

			const toggle = function (id) {
				const next = new Set(off);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				setOff(next);
				const v = viewRef.current;
				if (v) setHits(v.setLayerVisible(id, !next.has(id)));
			};

			const copy = async function () {
				if (!sel) return;
				try {
					await navigator.clipboard.writeText(String(sel.text || ""));
					setCopied("已复制");
				} catch (e) {
					setCopied("复制失败");
				}
				setTimeout(function () {
					setCopied("");
				}, 1400);
			};

			const legend = ((data && data.layers) || []).map(function (l) {
				return h(
					"div",
					{
						key: l.id,
						className: "mrs-lg" + (off.has(l.id) ? " mrs-lg-off" : ""),
						onClick: function () {
							toggle(l.id);
						},
						title: l.hint || "",
					},
					h("i", { style: { background: l.color, color: l.color } }),
					l.label,
					h("em", null, l.count),
				);
			});

			const detail = sel
				? h(
						"div",
						{ className: "mrs-detail" },
						h(
							"button",
							{
								className: "mrs-x",
								onClick: function () {
									setSel(null);
								},
							},
							"×",
						),
						h(
							"div",
							{ className: "mrs-meta" },
							h("span", null, sel.date),
							h("span", null, labelOfLayer(sel.layer)),
							sel.refineId ? h("span", null, sel.refineId) : null,
							sel.src ? h("span", null, sel.src) : null,
						),
						h("h3", null, sel.headline),
						h("div", { className: "mrs-body" }, sel.text),
						h(
							"div",
							{ className: "mrs-tags" },
							(sel.tags || []).slice(0, 6).map(function (t) {
								return h(
									"span",
									{
										key: t,
										className: "mrs-tag",
										onClick: function () {
											setQuery(t);
										},
									},
									t,
								);
							}),
						),
						h(
							"div",
							{ className: "mrs-foot" },
							h(
								"button",
								{ className: "mrf-btn", style: { fontSize: "11px", padding: "3px 9px" }, onClick: copy },
								copied || "复制原文",
							),
							h("span", null, sel.file + " : " + sel.line + " 行"),
						),
					)
				: null;

			const tip = hover
				? h(
						"div",
						{ className: "mrs-tip", style: { left: hover.sx + 14, top: hover.sy + 14 } },
						hover.headline,
						h("em", null, hover.date + " · " + labelOfLayer(hover.layer) + " · " + hover.chars + " 字"),
					)
				: null;

			const summary = data
				? data.total + " 条 · " + data.edges.length + " 条连线 · " + (data.range.from || "") + " → " + (data.range.to || "")
				: "";

			return h(
				"div",
				{ className: "mrs-root" },
				h(
					"div",
					{ className: "mrs-bar" },
					h("h2", { className: "mrs-title" }, "记 忆 海"),
					h("span", { className: "mrs-sub" }, summary),
					note ? h("span", { className: "mrs-note" }, note) : null,
					h(
						"div",
						{ className: "mrs-search" },
						h("input", {
							value: query,
							placeholder: "在这片海里捞点东西…",
							spellCheck: false,
							onChange: function (e) {
								setQuery(e.target.value);
							},
						}),
						h("span", { className: "mrs-cnt" }, query ? (hits ? hits + " 颗" : "没有") : ""),
					),
					h(
						"button",
						{
							className: "mrf-btn",
							disabled: busy,
							onClick: function () {
								load(deep);
							},
						},
						busy ? "读取…" : "重新铺",
					),
					h(
						"button",
						{
							className: "mrf-btn",
							disabled: busy,
							title: "沉积层是 archive 里被覆盖掉的旧版本，铺开会慢一点",
							onClick: function () {
								const next = !deep;
								setDeep(next);
								load(next);
							},
						},
						deep ? "收起海床" : "潜到海床",
					),
				),
				err ? h("div", { className: "mrf-msg mrf-err" }, err) : null,
				h("div", { className: "mrs-legend" }, legend),
				h(
					"div",
					{ className: "mrs-stage" },
					h(
						"div",
						{ className: "mrs-canvas-wrap" },
						h("canvas", { ref: canvasRef }),
						tip,
						!data && !err ? h("div", { className: "mrs-empty" }, busy ? "正在铺海…" : "") : null,
					),
					detail,
				),
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

			// 记忆海：跟记忆提炼并列的第二个入口，互不牵连 —— 这一半画不出来，
			// 那一半照样能改文件。
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{
								name: "sidebar.panellist",
								id: SEA_KEY,
								order: 22,
								label: () => "记忆海",
							},
							SeaIcon,
						),
					),
				"memory-refine: sea entry",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: SEA_KEY,
							},
							SeaPanel,
						),
					),
				"memory-refine: sea panel",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
