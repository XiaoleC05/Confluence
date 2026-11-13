// Confluence / 汇流 — Web panel client half (M3 v0.1.0, read-only).
//
// Plain browser module in the proven Dynamic ModuleLoader format:
//   window.__ModuleLoader__.load({ id, factory(require) { ... } })
// React comes from the module table (`require('react')`); no Harness client package
// is imported, there is no build step and no JSX.
//
// Data channel: four read-only same-origin JSON routes registered by the Host half
// (`lib/hostui.js`) on the existing DSH web server — the documented ADR-0005 route
// fallback for v0.1.0 (the `host.call` builtin is deferred; see docs/plan/m0-spikes.md
// S6). The only network call site in this file is the single relative GET in
// `request()`; there is no other transport, no iframe, no push channel and no POST.
//
// The panel is read-only: it never writes board data. It renders untrusted note text
// as React text children (never HTML), uses only `--dsw-alias-*` theme tokens, and
// unregisters everything through the owning context / React cleanup.

window.__ModuleLoader__.load({
  id: 'dsh-confluence',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'confluence'
    const ROUTE_BASE = '/confluence/panel'
    const POLL_MS = 5000
    const REQUEST_TIMEOUT_MS = 8000
    const BACKOFF_MS = [5000, 10000, 20000, 30000]
    const KIND_ORDER = ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning']
    const MAX_LIST = 50

    // Panel copy. The shipped locale resources (locale/en.json, locale/zh.json `ui`
    // object) are the canonical inventory; this dictionary is the runtime fallback
    // while packaging updates those files (the keys used here are reported in the
    // WP6 hand-off). Every `t('…')` literal below exists in both languages.
    const STRINGS = {
      en: {
        panel: "Confluence",
        "board.title": "Workspace board",
        "board.subtitle": "Notes shared by sessions in this workspace",
        "board.empty": "No shared notes yet. Sessions can publish notes with confluence_post.",
        "board.unread": "{n} unread",
        "pulse.title": "Workspace pulse",
        "pulse.empty": "Nothing new from other sessions.",
        "recall.title": "Recall from earlier sessions",
        "recall.empty": "No earlier session in this workspace matched.",
        "workspace.label": "Workspace",
        "workspace.unavailable": "Workspace memory is unavailable for this session.",
        "search.label": "Search the board",
        "search.placeholder": "Search notes, tags and kinds",
        "search.empty": "No board notes matched.",
        "questions.open": "Open questions",
        "handoffs.open": "Open handoffs",
        "peers.live": "{n} active now",
        markRead: "Mark all read",
        "markRead.done": "All notes marked read.",
        "entry.open": "Open",
        "entry.resolved": "Resolved",
        "ledger.title": "Recent sessions",
        "panel.subtitle": "Shared memory for this workspace, from every session that runs here.",
        "nav.back": "Back to chat",
        "action.refresh": "Refresh",
        "action.retry": "Retry",
        "action.cancel": "Cancel",
        "state.loading": "Loading shared memory…",
        "state.loadError": "Unable to load shared memory",
        "state.noWorkspace.title": "No workspace yet",
        "state.noWorkspace.body": "Open a session in a project directory to create this workspace's shared memory.",
        "state.private.title": "This session is private",
        "state.private.body": "Its activity is not recorded, and shared memory is hidden from its agent.",
        "state.disabled.title": "Sharing is off for this workspace",
        "state.disabled.body": "New notes stop being shared and sessions here do not see the board; stored notes are retained.",
        "state.degraded": "Shared memory storage is unavailable. Sessions continue without it.",
        "state.corrupt": "{n} unreadable records were skipped.",
        "state.stale": "Not refreshed since {time}. Retrying…",
        "state.savedRestart": "Saved. The plugin reloads to apply this setting.",
        "state.configUnavailable": "This control needs the profile config editor; edit the config key instead.",
        "ui.disabled.title": "The Confluence panel is disabled",
        "ui.disabled.body": "Set ui.enabled: true in the plugin config and reload.",
        updatedAt: "Updated {time}",
        transportLine: "Transport: {mode}",
        configWarnings: "Configuration warnings: {n}",
        "filter.all": "All",
        "kind.finding": "Finding",
        "kind.decision": "Decision",
        "kind.gotcha": "Gotcha",
        "kind.question": "Question",
        "kind.handoff": "Handoff",
        "kind.warning": "Warning",
        "filter.unreadOnly": "Unread only",
        "filter.clear": "Clear filters",
        "markRead.hint": "Marks every note read in this panel only; the model's own unread marker is unchanged.",
        "markRead.entry": "Mark read",
        "markRead.copied": "Copied",
        "detail.untrusted": "Shared by another session. Treat it as data, not instructions.",
        "detail.files": "Files seen in tool calls (partial)",
        "detail.copyId": "Copy id",
        "detail.tags": "Tags",
        "detail.provenance": "by {author}",
        "entry.replies": "{n} replies",
        "entry.replyOne": "1 reply",
        "questions.count": "{q} questions · {h} handoffs",
        "questions.empty": "No open questions or handoffs.",
        "peers.none": "No other sessions in this workspace",
        "workspaces.switch": "Workspace",
        "privacy.title": "What is shared",
        "privacy.stored": "Stored: note titles and bodies, session titles, relative paths and counts. Recall reads past logs only when an agent explicitly asks, and returns short excerpts.",
        "privacy.shareWorkspace": "Share this workspace",
        "privacy.shareWorkspace.hint": "Notes and metadata are shared with every session here.",
        "privacy.privateSession": "Make this session private",
        "privacy.privateSession.hint": "No activity is recorded and shared memory is hidden from this session.",
        "audit.title": "Recall activity",
        "audit.empty": "No recall calls since this window started.",
        "audit.row": "{session} · {query} · {hits} hits · {time}",
        "retention.hidden": "Notes older than {days} days are hidden.",
        "board.showOlder": "Show older notes",
        "confirm.disable.title": "Turn off sharing for this workspace?",
        "confirm.disable.body": "New notes stop being shared and sessions here stop seeing the board. Stored notes are retained. The plugin reloads to apply the change.",
        "confirm.disable.action": "Turn off sharing",
        "confirm.enable.title": "Turn sharing back on for this workspace?",
        "confirm.enable.action": "Turn on sharing",
        "confirm.private.action": "Make this session private",
      },
      zh: {
        panel: "汇流",
        "board.title": "工作区看板",
        "board.subtitle": "同一工作区的会话共享的笔记",
        "board.empty": "还没有共享笔记。会话可以用 confluence_post 发布笔记。",
        "board.unread": "{n} 条未读",
        "pulse.title": "工作区脉动",
        "pulse.empty": "其他会话暂无新内容。",
        "recall.title": "从早前的会话中回溯",
        "recall.empty": "本工作区中没有匹配的早前会话。",
        "workspace.label": "工作区",
        "workspace.unavailable": "当前会话无法使用工作区记忆。",
        "search.label": "搜索看板",
        "search.placeholder": "搜索笔记、标签和类型",
        "search.empty": "没有匹配的看板笔记。",
        "questions.open": "未解决的问题",
        "handoffs.open": "待接手的交接",
        "peers.live": "{n} 个会话活跃",
        markRead: "全部标为已读",
        "markRead.done": "所有笔记已标为已读。",
        "entry.open": "打开",
        "entry.resolved": "已解决",
        "ledger.title": "最近的会话",
        "panel.subtitle": "同一工作区中所有会话共享的记忆。",
        "nav.back": "返回对话",
        "action.refresh": "刷新",
        "action.retry": "重试",
        "action.cancel": "取消",
        "state.loading": "正在读取共享记忆…",
        "state.loadError": "无法读取共享记忆",
        "state.noWorkspace.title": "暂无工作区",
        "state.noWorkspace.body": "在项目目录中打开会话后，这里会出现该工作区的共享记忆。",
        "state.private.title": "此会话为私密",
        "state.private.body": "不会记录此会话的活动，其代理也看不到共享记忆。",
        "state.disabled.title": "此工作区已关闭共享",
        "state.disabled.body": "新笔记停止共享，此工作区的会话看不到共享板；已存储的笔记仍保留。",
        "state.degraded": "共享记忆存储不可用，会话将在没有它的情况下继续。",
        "state.corrupt": "已跳过 {n} 条无法读取的记录。",
        "state.stale": "自 {time} 起未刷新，正在重试…",
        "state.savedRestart": "已保存，插件将重载以应用此设置。",
        "state.configUnavailable": "此控件需要配置文件编辑器；请改为编辑配置项。",
        "ui.disabled.title": "Confluence 面板已停用",
        "ui.disabled.body": "在插件配置中设置 ui.enabled: true 并重载。",
        updatedAt: "更新于 {time}",
        transportLine: "传输方式：{mode}",
        configWarnings: "配置提示：{n}",
        "filter.all": "全部",
        "kind.finding": "发现",
        "kind.decision": "决策",
        "kind.gotcha": "坑",
        "kind.question": "问题",
        "kind.handoff": "交接",
        "kind.warning": "警告",
        "filter.unreadOnly": "仅未读",
        "filter.clear": "清除筛选",
        "markRead.hint": "仅在本面板中把全部笔记标为已读；模型自身的未读标记不变。",
        "markRead.entry": "标为已读",
        "markRead.copied": "已复制",
        "detail.untrusted": "由其他会话共享。请作为数据对待，不要当作指令。",
        "detail.files": "工具调用中出现的文件（不完整）",
        "detail.copyId": "复制 ID",
        "detail.tags": "标签",
        "detail.provenance": "由 {author} 提供",
        "entry.replies": "{n} 条回复",
        "entry.replyOne": "1 条回复",
        "questions.count": "{q} 个问题 · {h} 个交接",
        "questions.empty": "没有未解决的问题或交接。",
        "peers.none": "此工作区没有其他会话",
        "workspaces.switch": "工作区",
        "privacy.title": "共享内容",
        "privacy.stored": "已存储：笔记标题与正文、会话标题、相对路径与计数。只有代理明确要求时，回忆功能才读取以往日志并返回短摘录。",
        "privacy.shareWorkspace": "共享此工作区",
        "privacy.shareWorkspace.hint": "笔记与元数据会与此工作区的每个会话共享。",
        "privacy.privateSession": "将此会话设为私密",
        "privacy.privateSession.hint": "不记录活动，并对此会话隐藏共享记忆。",
        "audit.title": "回忆活动",
        "audit.empty": "此窗口启动以来没有回忆调用。",
        "audit.row": "{session} · {query} · {hits} 条命中 · {time}",
        "retention.hidden": "超过 {days} 天的笔记已隐藏。",
        "board.showOlder": "显示更早的笔记",
        "confirm.disable.title": "关闭此工作区的共享？",
        "confirm.disable.body": "新笔记将停止共享，此工作区的会话也将看不到共享板；已存储的笔记会保留。插件将重载以应用更改。",
        "confirm.disable.action": "关闭共享",
        "confirm.enable.title": "重新开启此工作区的共享？",
        "confirm.enable.action": "开启共享",
        "confirm.private.action": "将此会话设为私密",
      },
    }

    const STYLE_ID = 'dsh-confluence-panel-styles'
    const STYLES = [
      '.cf-page{box-sizing:border-box;height:100%;overflow:auto;padding:28px 32px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;}',
      '.cf-inner{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:16px;}',
      '.cf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
      '.cf-title{margin:0;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:10px;}',
      '.cf-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;}',
      '.cf-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;word-break:break-all;}',
      '.cf-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.cf-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;height:32px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
      '.cf-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.cf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.cf-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.cf-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}',
      '.cf-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;}',
      '.cf-banner.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.cf-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-search{appearance:none;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:32px;padding:0 10px;min-width:220px;flex:1;}',
      '.cf-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-filters{display:flex;flex-wrap:wrap;gap:6px;}',
      '.cf-grid{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:16px;align-items:start;}',
      '.cf-list{display:flex;flex-direction:column;gap:8px;min-width:0;}',
      '.cf-row{appearance:none;text-align:left;font:inherit;color:inherit;display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-left:2px solid transparent;border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;}',
      '.cf-row:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.cf-row[aria-current="true"]{border-left-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.cf-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.cf-row-top{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.cf-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:none;}',
      '.cf-row-title{font-size:13px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}',
      '.cf-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;display:flex;flex-wrap:wrap;gap:8px;}',
      '.cf-resolved{color:var(--dsw-alias-state-success-primary);}',
      '.cf-unread-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none;}',
      '.cf-detail{position:sticky;top:16px;display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.cf-detail h2{margin:0;font-size:16px;line-height:1.35;}',
      '.cf-body{white-space:pre-wrap;font-size:13px;line-height:1.6;word-break:break-word;}',
      '.cf-untrusted{margin:0;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}',
      '.cf-section-label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0;}',
      '.cf-tags,.cf-files{display:flex;flex-wrap:wrap;gap:5px;}',
      '.cf-tag{display:inline-flex;height:20px;align-items:center;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.cf-files code{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;}',
      '.cf-replies{display:flex;flex-direction:column;gap:8px;list-style:none;margin:0;padding:0;}',
      '.cf-reply{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.55;}',
      '.cf-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px;text-align:center;}',
      '.cf-empty strong{display:block;font-size:14px;margin-bottom:6px;}',
      '.cf-empty p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;}',
      '.cf-skeleton{height:58px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.cf-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;padding-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.cf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}',
      '@media (max-width:1023px){.cf-grid{grid-template-columns:minmax(0,1fr);}.cf-detail{position:static;}}',
      '@media (max-width:720px){.cf-page{padding:20px 18px 40px;}.cf-head{flex-direction:column;}.cf-actions{width:100%;justify-content:flex-start;}}',
      '@media (prefers-reduced-motion:reduce){.cf-row,.cf-btn{transition:none;}}',
    ].join('')

    // ------------------------------------------------------------------
    // small utilities
    // ------------------------------------------------------------------

    /** Replace `{name}` placeholders; unknown placeholders stay literal. */
    function format(template, params) {
      if (typeof template !== 'string') return ''
      if (params === undefined || params === null) return template
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(params, key)) {
          const value = params[key]
          return value === undefined || value === null ? '' : String(value)
        }
        return match
      })
    }

    /** Relative time for display only; payload timestamps stay absolute ISO strings. */
    function relativeTime(isoString) {
      if (typeof isoString !== 'string' || isoString.length === 0) return ''
      const then = Date.parse(isoString)
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return 'now'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + 'h'
      return Math.round(hours / 24) + 'd'
    }

    /** Local wall-clock time for the footer. */
    function clockTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
      } catch {
        return ''
      }
    }

    /** Normalized error shape for the panel (never renders host prose as markup). */
    function panelError(error) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
        return { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
      }
      return { code: 'PANEL_TRANSPORT_UNAVAILABLE', message: error instanceof Error ? error.message : '' }
    }

    // ------------------------------------------------------------------
    // one and only fetch call site (read-only, relative, same-origin GET)
    // ------------------------------------------------------------------

    /**
     * Read one panel route. The only network call in this module: a relative
     * same-origin GET with an 8 s timeout and strict JSON envelope validation.
     */
    async function request(path, params, signal) {
      const search = new URLSearchParams()
      const entries = params !== null && typeof params === 'object' ? Object.keys(params) : []
      for (const key of entries) {
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const suffix = search.toString().length > 0 ? '?' + search.toString() : ''
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const abortFromCaller = () => controller.abort()
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', abortFromCaller, { once: true })
      }
      try {
        const response = await fetch(ROUTE_BASE + path + suffix, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw { code: 'PANEL_HTTP_' + String(response.status), message: 'panel request failed' }
        const payload = await response.json()
        if (payload === null || typeof payload !== 'object') {
          throw { code: 'PANEL_TRANSPORT_BAD_PAYLOAD', message: 'invalid panel response' }
        }
        if (payload.ok === false) {
          const error = payload.error !== null && typeof payload.error === 'object' ? payload.error : {}
          throw { code: typeof error.code === 'string' ? error.code : 'PANEL_REQUEST_FAILED', message: typeof error.message === 'string' ? error.message : '' }
        }
        return payload
      } finally {
        clearTimeout(timeout)
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', abortFromCaller)
        }
      }
    }

    const api = {
      workspaces: () => request('/workspaces'),
      overview: (workspaceKey, options) => request('/overview', {
        ws: workspaceKey,
        q: options !== undefined ? options.q : undefined,
        kind: options !== undefined ? options.kind : undefined,
        limit: MAX_LIST,
      }),
      entry: (workspaceKey, id) => request('/entry', { ws: workspaceKey, id }),
    }

    // ------------------------------------------------------------------
    // presentational helpers
    // ------------------------------------------------------------------

    function KindPill(props) {
      return h('span', { className: 'cf-kind', title: props.kind }, props.t('kind.' + props.kind))
    }

    function PanelIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 6.5h7.2c1.2 0 2.1.4 2.9 1.2l1.9 1.9h4v8.9c0 1.2-1 2.2-2.2 2.2H6.2C5 20.7 4 19.7 4 18.5V6.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.2 13.2h3.1M8.2 16.1h5.4M15.9 13.2h.1',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    function Banner(props) {
      return h(
        'div',
        { className: 'cf-banner' + (props.error === true ? ' error' : ''), role: props.error === true ? 'alert' : 'status' },
        h('span', null, props.message),
        props.action !== undefined
          ? h('button', { type: 'button', className: 'cf-btn', onClick: props.action.onClick }, props.action.label)
          : null,
      )
    }

    function EmptyCard(props) {
      return h(
        'div',
        { className: 'cf-empty' },
        h('strong', null, props.title),
        props.body !== undefined ? h('p', null, props.body) : null,
      )
    }

    function TimeLabel(props) {
      const relative = relativeTime(props.iso)
      if (relative === '') return null
      return h('span', { title: props.iso }, relative)
    }

    // ------------------------------------------------------------------
    // main page
    // ------------------------------------------------------------------

    function ConfluencePage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => STRINGS.en[key] || key
      const closePanel = typeof props.closePanel === 'function' ? props.closePanel : () => {}

      const [workspaces, setWorkspaces] = React.useState([])
      const [workspaceKey, setWorkspaceKey] = React.useState('')
      const [overview, setOverview] = React.useState(null)
      const [entryView, setEntryView] = React.useState(null)
      const [phase, setPhase] = React.useState('loading') // loading | ready | empty | error
      const [error, setError] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      const [lastUpdated, setLastUpdated] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [debouncedQuery, setDebouncedQuery] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [selectedId, setSelectedId] = React.useState('')
      const mountedRef = React.useRef(true)
      const inFlightRef = React.useRef(false)
      const backoffRef = React.useRef(0)
      const requestRef = React.useRef(null)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          if (requestRef.current !== null && typeof requestRef.current.abort === 'function') requestRef.current.abort()
        }
      }, [])

      React.useEffect(() => {
        if (document.getElementById(STYLE_ID) !== null) return undefined
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = STYLES
        document.head.appendChild(element)
        return () => {
          if (element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, [])

      const loadWorkspaces = React.useCallback(async () => {
        const controller = new AbortController()
        requestRef.current = controller
        try {
          const payload = await api.workspaces()
          if (!mountedRef.current) return
          const list = Array.isArray(payload.workspaces) ? payload.workspaces : []
          setWorkspaces(list)
          if (list.length === 0) {
            setPhase('empty')
            return
          }
          const current = workspaceKey !== '' && list.some((item) => item.key === workspaceKey) ? workspaceKey : list[0].key
          setWorkspaceKey(current)
        } catch (caught) {
          if (!mountedRef.current) return
          setError(panelError(caught))
          setPhase('error')
        }
      }, [workspaceKey])

      const loadOverview = React.useCallback(async (key, silent) => {
        if (key === '' || inFlightRef.current) return
        inFlightRef.current = true
        const controller = new AbortController()
        requestRef.current = controller
        try {
          const params = {}
          if (debouncedQuery !== '') params.q = debouncedQuery
          if (kind !== '') params.kind = kind
          const payload = await request('/overview', { ws: key, q: params.q, kind: params.kind, limit: MAX_LIST }, controller.signal)
          if (!mountedRef.current) return
          setOverview(payload)
          setPhase('ready')
          setError(null)
          setStale(false)
          setLastUpdated(Date.now())
          backoffRef.current = 0
        } catch (caught) {
          if (!mountedRef.current) return
          if (silent === true && overview !== null) {
            setStale(true)
            backoffRef.current = Math.min(backoffRef.current + 1, BACKOFF_MS.length - 1)
            return
          }
          setError(panelError(caught))
          if (overview === null) setPhase('error')
        } finally {
          inFlightRef.current = false
        }
      }, [debouncedQuery, kind, overview])

      React.useEffect(() => {
        loadWorkspaces()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      React.useEffect(() => {
        if (workspaceKey === '') return
        loadOverview(workspaceKey, false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [workspaceKey, debouncedQuery, kind])

      React.useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250)
        return () => clearTimeout(timer)
      }, [query])

      React.useEffect(() => {
        if (workspaceKey === '' || typeof document === 'undefined') return undefined
        let cancelled = false
        let timer = null
        const schedule = () => {
          const delay = backoffRef.current === 0 ? POLL_MS : BACKOFF_MS[backoffRef.current]
          timer = setTimeout(tick, delay)
        }
        const tick = () => {
          if (cancelled) return
          if (document.visibilityState === 'visible') loadOverview(workspaceKey, true)
          schedule()
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible' && !cancelled) loadOverview(workspaceKey, true)
        }
        document.addEventListener('visibilitychange', onVisibility)
        schedule()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [workspaceKey, loadOverview])

      const openEntry = React.useCallback(async (id) => {
        setSelectedId(id)
        setEntryView(null)
        try {
          const payload = await api.entry(workspaceKey, id)
          if (!mountedRef.current) return
          setEntryView(payload)
        } catch (caught) {
          if (!mountedRef.current) return
          setError(panelError(caught))
        }
      }, [workspaceKey])

      const refresh = React.useCallback(() => {
        loadWorkspaces()
        if (workspaceKey !== '') loadOverview(workspaceKey, false)
      }, [loadWorkspaces, loadOverview, workspaceKey])

      const selectedWorkspace = workspaces.find((item) => item.key === workspaceKey)
      const entries = overview !== null && Array.isArray(overview.entries) ? overview.entries : []
      const peers = overview !== null && Array.isArray(overview.peers) ? overview.peers : []
      const stats = overview !== null && overview.stats !== null && typeof overview.stats === 'object' ? overview.stats : {}
      const hasFilters = debouncedQuery !== '' || kind !== ''
      const title = selectedWorkspace !== undefined && typeof selectedWorkspace.label === 'string' && selectedWorkspace.label !== ''
        ? selectedWorkspace.label
        : workspaceKey

      const header = h(
        'header',
        { className: 'cf-head' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('h1', { id: 'cf-title', className: 'cf-title' }, t('panel'), h('span', { className: 'cf-chip' }, t('workspace.label'))),
          h(
            'p',
            { className: 'cf-sub' },
            title,
            selectedWorkspace !== undefined && selectedWorkspace.canonicalPath !== ''
              ? ' · ' + selectedWorkspace.canonicalPath
              : '',
          ),
        ),
        h(
          'div',
          { className: 'cf-actions' },
          h(
            'span',
            { className: 'cf-pill', role: 'status' },
            h('span', { className: 'cf-dot' }),
            peers.length > 0
              ? format(t('peers.live'), { n: peers.length }) + ' · ' + peers.map((peer) => peer.title).slice(0, 2).join(', ')
              : t('peers.none'),
          ),
          h('button', { type: 'button', className: 'cf-btn', onClick: refresh }, t('action.refresh')),
          h('button', { type: 'button', className: 'cf-btn', onClick: () => closePanel() }, t('nav.back')),
        ),
      )

      const banners = []
      if (error !== null) {
        banners.push(h(Banner, {
          key: 'error',
          error: true,
          message: t('state.loadError') + (typeof error.message === 'string' && error.message !== '' ? ' — ' + error.message : ''),
          action: { label: t('action.retry'), onClick: refresh },
        }))
      }
      if (stale === true) {
        banners.push(h(Banner, {
          key: 'stale',
          message: t('updatedAt', { time: clockTime(lastUpdated) }),
          action: { label: t('action.retry'), onClick: refresh },
        }))
      }

      const toolbar = h(
        'div',
        { className: 'cf-toolbar', role: 'group', 'aria-label': t('search.label') },
        h('input', {
          className: 'cf-search',
          type: 'search',
          value: query,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.label'),
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          'div',
          { className: 'cf-filters' },
          h(
            'button',
            { type: 'button', className: 'cf-btn', 'aria-pressed': kind === '', onClick: () => setKind('') },
            t('filter.all'),
          ),
          KIND_ORDER.map((value) => h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'cf-btn',
              'aria-pressed': kind === value,
              onClick: () => setKind(kind === value ? '' : value),
            },
            t('kind.' + value),
          )),
          hasFilters
            ? h('button', { type: 'button', className: 'cf-btn', onClick: () => { setQuery(''); setKind(''); } }, t('filter.clear'))
            : null,
        ),
      )

      const list = h(
        'div',
        { className: 'cf-list' },
        h(
          'div',
          null,
          h('h2', { style: { margin: '0 0 4px', fontSize: '15px' } }, t('board.title')),
          h('p', { className: 'cf-sub', style: { margin: '0 0 8px' } }, t('board.subtitle')),
        ),
        entries.length === 0
          ? h(EmptyCard, {
              title: hasFilters ? t('search.empty') : t('board.empty'),
              body: hasFilters ? undefined : t('board.subtitle'),
            })
          : entries.map((entry) => h(
              'button',
              {
                key: entry.id,
                type: 'button',
                className: 'cf-row',
                'aria-current': selectedId === entry.id ? 'true' : undefined,
                onClick: () => openEntry(entry.id),
              },
              h(
                'span',
                { className: 'cf-row-top' },
                h(KindPill, { kind: entry.kind, t }),
                h('span', { className: 'cf-row-title' }, entry.title),
                entry.status === 'resolved' ? h('span', { className: 'cf-meta cf-resolved' }, t('entry.resolved')) : null,
              ),
              h(
                'span',
                { className: 'cf-meta' },
                h('span', null, format(t('detail.provenance'), { author: entry.authorTitle || '—' })),
                h(TimeLabel, { iso: entry.ts }),
                entry.replyCount > 0 ? h('span', null, format(t('entry.replies'), { n: entry.replyCount })) : null,
              ),
            )),
      )

      const detail = h(
        'aside',
        { className: 'cf-detail', role: 'region', 'aria-label': t('entry.open') },
        entryView !== null && entryView.entry !== null && typeof entryView.entry === 'object'
          ? [
              h('div', { key: 'head', className: 'cf-row-top' }, h(KindPill, { kind: entryView.entry.kind, t })),
              h('h2', { key: 'title' }, entryView.entry.title),
              h('p', { key: 'meta', className: 'cf-meta' },
                h('span', null, format(t('detail.provenance'), { author: entryView.entry.authorTitle || '—' })),
                h(TimeLabel, { iso: entryView.entry.ts })),
              h('p', { key: 'untrusted', className: 'cf-untrusted' }, t('detail.untrusted')),
              h('div', { key: 'body', className: 'cf-body' }, entryView.entry.body),
              Array.isArray(entryView.entry.tags) && entryView.entry.tags.length > 0
                ? h('div', { key: 'tags' },
                    h('p', { className: 'cf-section-label' }, t('detail.tags')),
                    h('div', { className: 'cf-tags' }, entryView.entry.tags.map((tag) => h('span', { key: tag, className: 'cf-tag' }, tag))))
                : null,
              Array.isArray(entryView.entry.files) && entryView.entry.files.length > 0
                ? h('div', { key: 'files' },
                    h('p', { className: 'cf-section-label' }, t('detail.files')),
                    h('div', { className: 'cf-files' }, entryView.entry.files.map((file) => h('code', { key: file }, file))))
                : null,
              Array.isArray(entryView.replies) && entryView.replies.length > 0
                ? h('ul', { key: 'replies', className: 'cf-replies' }, entryView.replies.map((reply) => h(
                    'li',
                    { key: reply.id, className: 'cf-reply' },
                    h('p', { className: 'cf-meta', style: { margin: '0 0 4px' } },
                      format(t('detail.provenance'), { author: reply.authorTitle || '—' }),
                      h(TimeLabel, { iso: reply.ts })),
                    h('div', { className: 'cf-body' }, reply.body),
                  )))
                : null,
            ]
          : h('p', { className: 'cf-untrusted' }, t('board.subtitle')),
      )

      let content
      if (phase === 'loading') {
        content = h('div', { 'aria-busy': 'true', 'aria-label': t('state.loading') },
          h('div', { className: 'cf-skeleton', 'aria-hidden': 'true' }),
          h('div', { className: 'cf-skeleton', 'aria-hidden': 'true', style: { marginTop: '8px' } }),
          h('p', { className: 'cf-sub' }, t('state.loading')))
      } else if (phase === 'empty') {
        content = h(EmptyCard, { title: t('workspace.unavailable'), body: t('board.subtitle') })
      } else if (phase === 'error' && overview === null) {
        content = h(EmptyCard, { title: t('state.loadError'), body: error !== null ? error.message : '' })
      } else {
        content = h('div', { className: 'cf-grid' }, list, detail)
      }

      return h(
        'section',
        { className: 'cf-page', 'aria-labelledby': 'cf-title' },
        h('div', { className: 'cf-inner' },
          header,
          banners.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, banners) : null,
          toolbar,
          content,
          h('footer', { className: 'cf-footer' },
            lastUpdated > 0 ? h('span', null, t('updatedAt', { time: clockTime(lastUpdated) })) : h('span'),
            h('span', null, t('questions.open') + ': ' + String(stats.openQuestions !== undefined ? stats.openQuestions : 0)
              + ' · ' + t('handoffs.open') + ': ' + String(stats.openHandoffs !== undefined ? stats.openHandoffs : 0))),
        ),
      )
    }

    // ------------------------------------------------------------------
    // factory
    // ------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const locale = ctx !== null && typeof ctx === 'object' ? ctx.locale : undefined
        if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
          const register = () => locale.register(NS, STRINGS)
          if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-confluence:locale')
          else register()
        }
        let bound = null
        try {
          bound = locale !== null && locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : null
        } catch {
          bound = null
        }
        const t = (key, params) => {
          let value = null
          if (typeof bound === 'function') {
            try {
              value = bound(key)
            } catch {
              value = null
            }
          }
          if (typeof value !== 'string' || value === '') value = STRINGS.en[key]
          if (typeof value !== 'string') value = key
          return format(value, params)
        }
        const layout = ctx !== null && typeof ctx === 'object' ? ctx.layout : undefined
        const closePanel = () => {
          try {
            if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
          } catch {
            // Presentation-only; never crash the panel.
          }
        }
        const slots = ctx !== null && typeof ctx === 'object' ? ctx.slots : undefined
        if (slots === null || slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          return undefined
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'confluence',
            order: 30,
            locale: NS,
            label: () => t('panel'),
          },
          PanelIcon,
        ))
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register(
            {
              name: 'main',
              key: 'confluence',
              locale: NS,
              inject: () => ({ t, closePanel }),
            },
            ConfluencePage,
          )
        })
        return undefined
      },
    }
  },
})
