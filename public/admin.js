/* 管理页脚本：现代 JS（ES2020+），只在 Chrome / Edge 运行。
 * IE 打开时由 head 内联脚本切到 ie-blocked，只会看到兜底提示。
 */
(function () {
  'use strict'

  var PLATFORMS = window.__PLATFORMS__ || []
  var COVERAGE = window.__COVERAGE__ || []
  var TOTAL_COMBOS = 8

  function $(id) { return document.getElementById(id) }

  var form = $('upload-form')
  if (!form) return

  var fVersion = $('f-version')
  var fPlatform = $('f-platform')
  var fArch = $('f-arch')
  var fFile = $('f-file')
  var fChangelog = $('f-changelog')
  var dz = $('dropzone')
  var dzFile = $('dz-file')
  var dzHint = $('dz-hint')
  var progressWrap = $('progress-wrap')
  var progressBar = $('progress-bar')
  var uploadMeta = $('upload-meta')
  var formTip = $('form-tip')
  var channelTag = $('channel-tag')
  var coverageEl = $('coverage')
  var submitBtn = $('submit-btn')
  var pauseBtn = $('pause-btn')
  var cancelBtn = $('cancel-btn')
  var forceBtn = $('force-release')

  var selectedFile = null
  var uploading = false
  // 当前正在上传的会话 id：页面刷新/关闭时据此调 DELETE，把服务端会话和占位一起收掉
  var activeUploadId = ''

  function platformById(id) {
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i].id === id) return PLATFORMS[i]
    }
    return null
  }

  function normalize(v) {
    return String(v || '').trim().replace(/^v/i, '')
  }

  function fmtBytes(n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    var units = ['KB', 'MB', 'GB', 'TB']
    var v = n / 1024
    var i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i]
  }

  function bumpPatch(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    if (!m) return ''
    return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1)
  }

  function readMem() {
    try { return JSON.parse(sessionStorage.getItem('online-exe-upload') || '{}') }
    catch (e) { return {} }
  }

  function saveMem() {
    try {
      sessionStorage.setItem('online-exe-upload', JSON.stringify({
        version: fVersion.value,
        platform: fPlatform.value,
        arch: fArch.value
      }))
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function renderArchs(desired) {
    var p = platformById(fPlatform.value)
    fArch.innerHTML = ''
    if (!p) return
    p.arches.forEach(function (a) {
      var opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = a.label
      fArch.appendChild(opt)
    })
    if (desired) {
      var ok = p.arches.some(function (a) { return a.id === desired })
      if (ok) fArch.value = desired
    }
  }

  function updateChannel(v) {
    var beta = /^\d+\.\d+\.\d+-/.test(v)
    channelTag.textContent = beta ? '预发布 Beta' : '正式'
    channelTag.className = 'channel-tag' + (beta ? ' beta' : '')
  }

  function updateCoverage() {
    var v = normalize(fVersion.value)
    updateChannel(v)

    if (!v) {
      coverageEl.textContent = '填写版本号后显示覆盖度'
      coverageEl.className = 'field-hint'
      return
    }

    var covered = {}
    COVERAGE.forEach(function (r) {
      if (r.version === v) covered[r.platform + '-' + r.arch] = true
    })

    var count = Object.keys(covered).length
    var missing = []
    PLATFORMS.forEach(function (p) {
      p.arches.forEach(function (a) {
        var k = p.id + '-' + a.id
        if (!covered[k]) missing.push(k)
      })
    })

    if (count === 0) {
      coverageEl.textContent = v + ' 尚未覆盖任何组合（共 ' + TOTAL_COMBOS + ' 组）'
      coverageEl.className = 'field-hint'
    } else if (missing.length === 0) {
      coverageEl.textContent = v + ' 已覆盖 ' + TOTAL_COMBOS + '/' + TOTAL_COMBOS + ' 组合'
      coverageEl.className = 'field-hint'
    } else {
      coverageEl.textContent = v + ' 已覆盖 ' + count + '/' + TOTAL_COMBOS + ' 组合，缺少：' + missing.join('、')
      coverageEl.className = 'field-hint warn'
    }
  }

  function setFile(file) {
    if (file) {
      var check = checkFile(file)
      if (!check.ok) {
        // 不合规的文件不进 selectedFile：按钮点了也只会拿到后端 400，不如当场说清楚
        selectedFile = null
        dzFile.textContent = ''
        fFile.value = ''
        fail(check.error)
        return false
      }
    }
    selectedFile = file || null
    dzFile.textContent = selectedFile
      ? selectedFile.name + ' · ' + fmtBytes(selectedFile.size)
      : ''
    if (selectedFile) {
      formTip.className = 'form-tip'
      formTip.textContent = ''
    }
    return true
  }

  // ── 文件类型白名单 ────────────────────────────────────────────────
  // 规则来自服务端 src/filetypes.js（admin.ejs 把列表与提示文案序列化到 data-ext-*），
  // 前端只负责「选的时候就告诉用户不行」，真正的拦截仍在后端。
  // 后缀全平台通用：换平台不会让已选文件失效，平台只决定这条记录归到哪个区块。
  var EXT_LIST = []
  try { EXT_LIST = JSON.parse(form.getAttribute('data-ext-list') || '[]') } catch (e) { EXT_LIST = [] }
  var EXT_TEXT = form.getAttribute('data-ext-text') || EXT_LIST.join(' / ')
  // 异常提示里用紧凑写法（无空格），尽量压在一条行内，别把按钮区撑成两行
  var EXT_TEXT_COMPACT = form.getAttribute('data-ext-compact') || EXT_LIST.join('/')

  // 多段后缀优先匹配，与 filetypes.js 的 fileExt() 一致（否则 x.tar.gz 会被切成 .gz）
  var MULTI_EXTS = ['.tar.gz', '.tar.xz', '.tar.bz2']

  function fileExt(name) {
    var n = String(name || '').trim().toLowerCase()
    if (!n) return ''
    for (var i = 0; i < MULTI_EXTS.length; i++) {
      if (n.slice(-MULTI_EXTS[i].length) === MULTI_EXTS[i]) return MULTI_EXTS[i]
    }
    var dot = n.lastIndexOf('.')
    if (dot <= 0 || dot === n.length - 1) return ''
    return n.slice(dot)
  }

  /** 拖拽区下方的「仅接受 …」提示：白名单全平台一致，只需渲染一次 */
  function refreshDzHint() {
    if (!dzHint) return
    dzHint.textContent = EXT_LIST.length ? '仅接受安装包：' + EXT_TEXT : ''
  }

  /** @returns {{ok:true, ext:string} | {ok:false, error:string}} */
  function checkFile(file) {
    if (!file) return { ok: false, error: '请选择要上传的产物文件' }
    var ext = fileExt(file.name)
    if (ext && EXT_LIST.indexOf(ext) >= 0) return { ok: true, ext: ext }
    var why = ext ? '（' + ext + '）' : '（没有扩展名）'
    return {
      ok: false,
      error: '「' + file.name + '」不是安装包' + why + '；仅接受 ' + EXT_TEXT_COMPACT +
        '。图片、视频、PDF、文档等一律不允许上传。',
    }
  }

  function fail(msg) {
    formTip.className = 'form-tip err'
    formTip.textContent = msg
  }

  function resetButton() {
    uploading = false
    activeUploadId = ''
    submitBtn.disabled = false
    submitBtn.textContent = '开始上传'
    pauseBtn.hidden = true
    pauseBtn.disabled = false
    pauseBtn.textContent = '暂停上传'
    cancelBtn.hidden = true
    forceBtn.hidden = true
    forceBtn.disabled = false
    forceBtn.textContent = '释放上次残留'
  }

  // 初始化：恢复表单记忆
  var mem = readMem()
  if (mem.platform) fPlatform.value = mem.platform
  renderArchs(mem.arch)
  if (mem.version) fVersion.value = mem.version
  updateCoverage()
  refreshDzHint()

  fPlatform.addEventListener('change', function () {
    renderArchs(null)
    saveMem()
    updateCoverage()
    // 换平台不需要重判已选文件：白名单对所有平台一致，选择保持有效
  })
  fArch.addEventListener('change', saveMem)
  fVersion.addEventListener('input', function () {
    saveMem()
    updateCoverage()
  })

  // 文件选择与拖拽
  dz.addEventListener('click', function () {
    if (!uploading) fFile.click()
  })
  fFile.addEventListener('change', function () {
    setFile(fFile.files && fFile.files[0])
  })
  ;['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault()
      dz.classList.add('hover')
    })
  })
  ;['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault()
      dz.classList.remove('hover')
    })
  })
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) setFile(f)
  })

  /**
   * 该「版本 + 平台 + 架构」是否已被占用。判据与后端 upload.js 的 isVersionTaken 一致：
   * 墓碑（deleted）和缺文件（file_missing）放行，其余在架/已撤回都算占用。
   * 直接读列表 DOM，所以撤回、恢复、删除这些行内操作之后仍然是准的。
   */
  function isTaken(version, platform, arch) {
    var rows = allRows()
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-version') !== version) continue
      if (rows[i].getAttribute('data-platform') !== platform) continue
      if (rows[i].getAttribute('data-arch') !== arch) continue
      if (rows[i].getAttribute('data-status') === 'deleted') continue
      if (rows[i].getAttribute('data-missing') === '1') continue
      return true
    }
    return false
  }

  // ── 分片上传 ──────────────────────────────────────────────────────
  // 为什么分片：400MB 单连接在这条链路上传不完 —— 实测连接会在 24~45 秒被掐断
  // （服务端只看到 request_error / ECONNRESET）。切片之后断了只补一片，不用整包重来。
  //
  // 分片大小默认 40MB。注意这跟「躲开掐断阈值」是矛盾的：链路慢的时候 40MB 一片
  // 可能要传好几分钟，照样会被掐。好处是请求数少（400MB 只要 10 片），
  // 代价是单片失败要从头重传 40MB。小包或者链路差时用 ?chunk=8 换回来。
  //
  // 关于并发：**实测这条链路并发越多越慢**，同一台机器同一个文件 48MB：
  //   1 并发 4.58 MB/s ｜ 2 并发 4.52 ｜ 3 并发 4.15 ｜ 4 并发 3.35 ｜ 6 并发 2.78
  // 所以默认 1。换成干净链路想调大时，直接在地址栏加 ?c=4，不用改代码重发版。

  function intParam(name, def) {
    var m = new RegExp('[?&]' + name + '=([^&]+)').exec(location.search || '')
    var n = m ? parseInt(decodeURIComponent(m[1]), 10) : NaN
    return isFinite(n) ? n : def
  }

  var CONCURRENCY = Math.min(8, Math.max(1, intParam('c', 1)))
  var CHUNK_SIZE = Math.min(64, Math.max(1, intParam('chunk', 40))) * 1024 * 1024

  // 单片最多重试次数（不含首次）
  var MAX_RETRY = 3

  // 提交上传
  form.addEventListener('submit', function (e) {
    e.preventDefault()
    if (uploading) return

    var version = normalize(fVersion.value)
    var platform = fPlatform.value
    var arch = fArch.value
    var changelog = fChangelog.value

    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      fail('版本号格式不合法，应为 1.3.0 或 1.3.0-beta.1')
      return
    }
    if (!platform || !arch) {
      fail('请选择平台与架构')
      return
    }
    if (!selectedFile) {
      fail('请选择要上传的产物文件')
      return
    }
    // 后端还会再判一次，这里只是省掉一次注定失败的往返（尤其大文件要等很久）
    var typeCheck = checkFile(selectedFile)
    if (!typeCheck.ok) {
      fail(typeCheck.error)
      return
    }

    // 版本已被占用时必须本地拦住：服务端会在读完 body 之前回 409 就关连接，
    // 浏览器还在推几百 MB，响应会被 RST 吞掉，用户只会看到「连接中断」。
    if (isTaken(version, platform, arch)) {
      var bumped = bumpPatch(version)
      if (bumped) {
        fVersion.value = bumped
        saveMem()
        updateCoverage()
      }
      fail(version + ' / ' + platform + ' / ' + arch + ' 已存在' +
        (bumped ? '，已自动改为 ' + bumped + '，请确认后再次点击上传' : '，请改用新版本号'))
      return
    }

    // 更新说明走请求头。HTTP 头只吃 ASCII，所以 encodeURIComponent 后送，
    // 服务端 decodeURIComponent 解回。Node 默认整个请求头上限 16KB，留一半余量。
    var changelogHeader = ''
    if (changelog) {
      changelogHeader = encodeURIComponent(changelog)
      if (changelogHeader.length > 8000) {
        fail('更新说明太长（' + changelog.length + ' 字），请精简到 800 字以内再传')
        return
      }
    }

    startChunkedUpload({
      version: version,
      platform: platform,
      arch: arch,
      changelogHeader: changelogHeader,
      file: selectedFile
    })
  })

  // 页面刷新 / 关闭 = 取消上传：把服务端会话和 inflight 占位一起收掉，
  // 否则同版本再次上传会一直吃 409（要等 10 分钟闲置 GC 才释放）。
  window.addEventListener('pagehide', function () {
    if (!activeUploadId) return
    var url = '/api/uploads/' + encodeURIComponent(activeUploadId)
    activeUploadId = ''
    try {
      // keepalive 让请求在页面卸载后仍能发出（DELETE 也支持）
      fetch(url, { method: 'DELETE', keepalive: true })
    } catch (e) { /* ignore */ }
  })

  // 「释放上次残留」：按 version+platform+arch 清掉异常中断留下的会话，然后自动重传
  forceBtn.addEventListener('click', function () {
    var version = normalize(fVersion.value)
    var platform = fPlatform.value
    var arch = fArch.value
    forceBtn.disabled = true
    forceBtn.textContent = '正在释放…'
    fetch('/api/uploads?version=' + encodeURIComponent(version) +
      '&platform=' + encodeURIComponent(platform) +
      '&arch=' + encodeURIComponent(arch), { method: 'DELETE' })
      .then(function (r) {
        forceBtn.disabled = false
        forceBtn.textContent = '释放上次残留'
        if (!r.ok) {
          fail('释放失败（HTTP ' + r.status + '），请稍后再试')
          return
        }
        forceBtn.hidden = true
        formTip.className = 'form-tip ok'
        formTip.textContent = '已释放上次残留，正在重新上传…'
        if (form.requestSubmit) form.requestSubmit()
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      .catch(function () {
        forceBtn.disabled = false
        forceBtn.textContent = '释放上次残留'
        fail('释放失败：连接中断')
      })
  })

  function startChunkedUpload(opts) {
    var file = opts.file
    var total = file.size
    var id = ''
    var chunkSize = CHUNK_SIZE
    var chunks = 0
    var okChunks = 0
    var completedBytes = 0
    var loaded = {}        // index -> 该片已发出字节（只用于进度显示）
    var startedAt = 0
    var finished = false
    var paused = false
    var queue = []         // 待传分片序号
    var xhrs = {}          // index -> 正在飞的 XHR，暂停/取消时中断
    var gen = 0            // 代际：暂停/取消时 +1，让旧请求的回调全部失效
    var renderTimer = null
    var heartbeat = null

    uploading = true
    activeUploadId = ''
    submitBtn.disabled = true
    submitBtn.textContent = '上传中…'
    pauseBtn.hidden = true
    pauseBtn.disabled = false
    pauseBtn.textContent = '暂停上传'
    cancelBtn.hidden = false
    forceBtn.hidden = true
    formTip.className = 'form-tip'
    formTip.textContent = ''
    progressWrap.classList.add('show')
    progressBar.style.width = '0%'
    uploadMeta.textContent = '正在建立上传会话…'
    startedAt = Date.now()

    // 用 onclick 覆盖而不是 addEventListener：不会每传一次就多挂一份监听
    pauseBtn.onclick = function () { paused ? resumeUpload() : pauseUpload() }
    cancelBtn.onclick = cancelUpload

    function scheduleRender() {
      if (renderTimer) return
      renderTimer = setTimeout(function () { renderTimer = null; render() }, 200)
    }

    function render() {
      // 暂停期间进度冻结：中断的分片要重传，不能让进度条往回跳
      if (paused) return
      var inflightBytes = 0
      for (var k in loaded) inflightBytes += loaded[k]
      var done = Math.min(total, completedBytes + inflightBytes)
      var pct = total > 0 ? done / total * 100 : 0
      progressBar.style.width = pct.toFixed(1) + '%'
      var sec = (Date.now() - startedAt) / 1000
      var speed = sec > 0 ? done / sec : 0
      uploadMeta.textContent = pct.toFixed(1) + '% · ' +
        fmtBytes(done) + ' / ' + fmtBytes(total) + ' · ' +
        fmtBytes(speed) + '/s · 分片 ' + okChunks + '/' + chunks +
        (paused ? ' · 已暂停' : '')
    }

    function stopHeartbeat() {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    }

    // 暂停期间没有任何请求，靠定时查进度给会话续命：服务端 uploadStatus 会刷新 updatedAt，
    // 否则闲置 10 分钟就被 GC 掉，点「继续」只能看到 410。
    function startHeartbeat() {
      if (heartbeat) return
      heartbeat = setInterval(function () {
        if (finished || !id) return
        fetch('/api/uploads/' + encodeURIComponent(id))
          .then(function (r) {
            if (r.status === 410) finishWithError('上传会话已过期（暂停太久），请重新上传')
          })
          .catch(function () { /* 单次心跳失败不处理，下一轮再试 */ })
      }, 60000)
    }

    /** 中断所有在飞请求并让它们的回调失效，避免暂停后旧请求继续触发重试/计数 */
    function abortAllXhr() {
      gen += 1
      var list = xhrs
      xhrs = {}
      loaded = {}
      for (var k in list) {
        try { list[k].abort() } catch (e) { /* ignore */ }
      }
    }

    function dropSession() {
      if (!id) return
      var url = '/api/uploads/' + encodeURIComponent(id)
      id = ''
      activeUploadId = ''
      try {
        fetch(url, { method: 'DELETE', keepalive: true })
      } catch (e) { /* ignore */ }
    }

    function finishWithError(msg, body) {
      if (finished) return
      finished = true
      stopHeartbeat()
      abortAllXhr()
      resetButton()
      if (!msg) msg = '上传失败'
      if (body && body.existing && body.existing.version) {
        var next = bumpPatch(body.existing.version)
        if (next) {
          fVersion.value = next
          saveMem()
          updateCoverage()
          msg = msg + '，已自动改为 ' + next
        }
      }
      fail(msg)
    }

    function giveUp(msg) {
      if (finished) return
      // 主动把会话删掉，别让服务器上的 tmp 和占位挂到 10 分钟后被 GC
      dropSession()
      finishWithError(msg)
    }

    function cancelUpload() {
      if (finished) return
      if (!window.confirm('确定取消本次上传？\n服务器上已传的分片会被删除。')) return
      giveUp('已取消上传，服务器上的临时分片已清理')
    }

    function pauseUpload() {
      if (finished || paused || !id) return
      // 中断前先把「已发出但还没确认」的字节也算上，暂停那一瞬间的进度条不往回跳
      var shown = completedBytes
      for (var k in loaded) shown += loaded[k]
      shown = Math.min(total, shown)
      paused = true
      abortAllXhr()
      startHeartbeat()
      pauseBtn.textContent = '继续上传'
      var pct = total > 0 ? shown / total * 100 : 0
      progressBar.style.width = pct.toFixed(1) + '%'
      uploadMeta.textContent = pct.toFixed(1) + '% · ' +
        fmtBytes(shown) + ' / ' + fmtBytes(total) + ' · 已暂停'
    }

    function resumeUpload() {
      if (finished || !paused) return
      pauseBtn.disabled = true
      fetch('/api/uploads/' + encodeURIComponent(id))
        .then(function (r) {
          if (r.status === 410) {
            finishWithError('上传会话已过期（暂停太久），请重新上传')
            return null
          }
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        })
        .then(function (d) {
          if (!d || finished) return
          // 以服务端为准重建进度和待传队列：暂停时中断的那片本来就没算成功
          var missing = d.missing || []
          var doneBytes = 0
          for (var i = 0; i < chunks; i++) {
            if (missing.indexOf(i) !== -1) continue
            var s = i * chunkSize
            doneBytes += Math.min(s + chunkSize, total) - s
          }
          okChunks = chunks - missing.length
          completedBytes = doneBytes
          queue = missing.slice()
          loaded = {}
          paused = false
          pauseBtn.disabled = false
          pauseBtn.textContent = '暂停上传'
          stopHeartbeat()
          scheduleRender()
          pump()
        })
        .catch(function () {
          pauseBtn.disabled = false
          fail('查询上传进度失败，请再点一次「继续上传」')
        })
    }

    function onUploaded(data) {
      finished = true
      resetButton()
      progressBar.style.width = '100%'
      uploadMeta.textContent = '上传成功 · sha256 ' + String(data.sha256 || '').slice(0, 8)
      formTip.className = 'form-tip ok'
      formTip.textContent = '已发布 ' + data.version + ' / ' + data.platform + ' / ' + data.arch
      setFile(null)
      fFile.value = ''
      try { sessionStorage.setItem('online-exe-flash', data.id || '') } catch (e) { /* ignore */ }
      setTimeout(function () { location.reload() }, 900)
    }

    function postJson(url, body) {
      return fetch(url, { method: 'POST', body: body }).then(function (r) {
        return r.text().then(function (t) {
          var data = {}
          try { data = JSON.parse(t || '{}') } catch (e) { /* 非 JSON 就当空 */ }
          return { ok: r.ok, status: r.status, data: data }
        })
      })
    }

    // ① 建会话：服务端在这里做查重、占位、磁盘预检，并预建好 tmp 文件
    var initUrl = '/api/uploads?version=' + encodeURIComponent(opts.version) +
      '&platform=' + encodeURIComponent(opts.platform) +
      '&arch=' + encodeURIComponent(opts.arch) +
      '&total=' + total +
      '&chunkSize=' + CHUNK_SIZE

    var initHeaders = {}
    try {
      initHeaders['X-Filename'] = encodeURIComponent(file.name)
    } catch (e) { /* 头值非法就退回服务端默认文件名 */ }
    if (opts.changelogHeader) initHeaders['X-Changelog'] = opts.changelogHeader

    fetch(initUrl, { method: 'POST', headers: initHeaders })
      .then(function (r) {
        return r.text().then(function (t) {
          var data = {}
          try { data = JSON.parse(t || '{}') } catch (e) { /* ignore */ }
          if (!r.ok) {
            finishWithError(data.error || ('无法建立上传会话（HTTP ' + r.status + '）'), data)
            // 上次异常中断留下的占位：给一个按钮直接释放，不用等 10 分钟 GC
            if (data.code === 'inflight') forceBtn.hidden = false
            return
          }
          // 建会话期间用户已经点了「取消」：把刚建出来的会话立刻删掉，别留占位
          if (finished) {
            try {
              fetch('/api/uploads/' + encodeURIComponent(data.id), { method: 'DELETE', keepalive: true })
            } catch (e4) { /* ignore */ }
            return
          }
          id = data.id
          activeUploadId = id
          chunkSize = data.chunkSize || CHUNK_SIZE
          chunks = data.chunks
          queue = []
          for (var qi = 0; qi < chunks; qi++) queue.push(qi)
          pauseBtn.hidden = false
          pump()
        })
      })
      .catch(function () {
        finishWithError('无法建立上传会话：连接被中断')
      })

    // ② 并发推分片：在飞数量 = xhrs 的键数，谁先回来谁补下一个
    function pump() {
      if (finished || paused) return
      while (queue.length > 0 && Object.keys(xhrs).length < CONCURRENCY) {
        attempt(queue.shift())
      }
      if (okChunks === chunks && chunks > 0) commit()
    }

    function attempt(index) {
      if (finished || paused) return
      var myGen = gen
      var start = index * chunkSize
      var end = Math.min(start + chunkSize, total)
      var size = end - start
      var tries = 0

      function send() {
        if (finished || paused || myGen !== gen) return
        var xhr = new XMLHttpRequest()
        var settled = false
        xhrs[index] = xhr
        loaded[index] = 0

        function retry(why) {
          loaded[index] = 0
          tries += 1
          if (tries > MAX_RETRY) {
            giveUp('第 ' + (index + 1) + ' 片重试 ' + MAX_RETRY + ' 次仍失败（' + why + '）。已上传 ' +
              okChunks + '/' + chunks + ' 片，重试会重新开始；可换网络后再试。')
            return
          }
          setTimeout(send, 400 * tries)
        }

        xhr.open('PUT', '/api/uploads/' + encodeURIComponent(id) + '/chunks?offset=' + start, true)
        // 与单包上传同一个理由：刻意不用 multipart，链路会按 Content-Type 丢包
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.upload.onprogress = function (ev) {
          if (!ev.lengthComputable || paused || myGen !== gen) return
          loaded[index] = ev.loaded
          scheduleRender()
        }
        xhr.onload = function () {
          if (settled) return
          settled = true
          if (myGen !== gen) return          // 暂停/取消后残留的旧请求，回调全部作废
          delete xhrs[index]
          if (finished) return
          if (xhr.status >= 200 && xhr.status < 300) {
            okChunks += 1
            completedBytes += size
            delete loaded[index]
            scheduleRender()
            pump()
            return
          }
          var msg = ''
          try { msg = (JSON.parse(xhr.responseText || '{}').error) || '' } catch (e2) { /* ignore */ }
          // 410 = 会话被回收（服务重启 / 闲置超时），重试也没用
          if (xhr.status === 410) {
            giveUp(msg || '上传会话已过期，请重新上传')
            return
          }
          retry(msg || ('HTTP ' + xhr.status))
        }
        xhr.onerror = function () {
          if (settled) return
          settled = true
          if (myGen !== gen) return
          delete xhrs[index]
          retry('连接中断')
        }
        xhr.onabort = function () {
          if (settled) return
          settled = true
          if (myGen !== gen) return
          delete xhrs[index]
          retry('请求被中止')
        }
        try {
          xhr.send(file.slice(start, end))
        } catch (e3) {
          if (settled) return
          settled = true
          if (myGen !== gen) return
          delete xhrs[index]
          retry('切片失败')
        }
      }

      send()
    }

    // ③ 让服务端做 fsync + sha256 + 落记录
    function commit() {
      if (finished) return
      stopHeartbeat()
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
      progressBar.style.width = '100%'
      uploadMeta.textContent = '分片已传完，正在校验并提交…'
      postJson('/api/uploads/' + encodeURIComponent(id) + '/complete')
        .then(function (res) {
          if (res.status === 201) {
            onUploaded(res.data)
            return
          }
          finishWithError(res.data.error || ('提交失败（HTTP ' + res.status + '）'), res.data)
        })
        .catch(function () {
          finishWithError('提交失败：连接中断。分片已保留在服务器，但刷新页面后需要重新上传。')
        })
    }
  }

  // 行操作：撤回 / 恢复 / 删除 / 重新上传
  function closestAction(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-action')) return node
      node = node.parentNode
    }
    return null
  }

  // ── 状态徽章 / 行内更新 ───────────────────────────────────────────
  // 撤回、恢复、删除都不再整页刷新，只改这一行。
  // 原因有两个：① 刷新会把滚动位置打回顶部，列表长时每操作一次就得重新往下找；
  //           ② 刷新后按当前筛选重新过滤，撤回的行在「正式」筛选下会直接消失，
  //              用户会以为记录被删了 —— 其实只是筛掉了。

  /** 状态徽章：规则必须和 views/admin.ejs 的 <td class="cell-status"> 那段一致 */
  function badgeHtml(status, missing) {
    var out = ''
    if (status === 'deleted') out += '<span class="badge">已删除</span>'
    if (status === 'yanked') out += '<span class="badge">已撤回</span>'
    if (status === 'active') out += '<span class="badge badge-ok">在架</span>'
    if (missing) out += '<span class="badge badge-danger">缺文件</span>'
    return out
  }

  function flashRow(tr) {
    tr.classList.add('row-flash')
    setTimeout(function () { tr.classList.remove('row-flash') }, 3000)
  }

  /**
   * 就地切换一行的状态。
   * 操作列只改「撤回 ↔ 恢复」那一颗按钮：两个动作落在同一个按钮上，
   * 这样不必把模板里的按钮矩阵在 JS 里重写一遍，少一处会漂移的实现。
   */
  function applyStatus(tr, status) {
    tr.setAttribute('data-status', status)
    var missing = tr.getAttribute('data-missing') === '1'

    var cell = tr.querySelector('.cell-status')
    if (cell) cell.innerHTML = badgeHtml(status, missing)

    var ops = tr.querySelector('.ops')
    var btn = ops && ops.querySelector('[data-action="yank"], [data-action="restore"]')
    if (!btn) return

    if (status === 'yanked') {
      btn.setAttribute('data-action', missing ? '' : 'restore')
      btn.textContent = '恢复'
      btn.disabled = missing
      if (missing) btn.title = '文件缺失：请先重新上传，再恢复'
      else btn.removeAttribute('title')
    } else {
      btn.setAttribute('data-action', 'yank')
      btn.textContent = '撤回'
      btn.disabled = false
      btn.removeAttribute('title')
    }
  }

  // ── 前端筛选 ──────────────────────────────────────────────────
  // 切筛选不再整页刷新：所有行都已经在 DOM 里，只切 row-hidden 的显隐。
  // 为什么必须这样：整页刷新会重置滚动位置（页面跳一下），列表变短时纵向滚动条
  // 消失还会让整张表横向重排 —— 这两件事叠起来就是肉眼可见的「抖动」。
  // URL 用 replaceState 同步，刷新页面或分享链接时，服务端仍按参数渲染同样的结果。

  function currentFilter() {
    var form = $('filter-form')
    var s = form && form.querySelector('select[name="status"]')
    var p = form && form.querySelector('select[name="platform"]')
    return { status: s ? s.value : 'all', platform: p ? p.value : 'all' }
  }

  /** 这一行在该筛选下是否该出现。规则与 src/routes/releases.js 的 STATUS_FILTERS 一一对应 */
  function rowMatches(tr, f) {
    var status = tr.getAttribute('data-status')
    var missing = tr.getAttribute('data-missing') === '1'
    var beta = tr.getAttribute('data-prerelease') === '1'
    var platform = tr.getAttribute('data-platform')

    if (f.platform !== 'all' && platform !== f.platform) return false
    if (f.status === 'all') return status !== 'deleted'
    if (f.status === 'stable') return status === 'active' && !beta
    // 没有 prerelease 分支：管理页不再提供「预发布」筛选项（上传入口不区分渠道，
    // 这一项永远筛出空列表）。接口层仍支持 status=prerelease，见 releases.js 的 STATUS_FILTERS。
    if (f.status === 'yanked') return status === 'yanked'
    if (f.status === 'missing') return status !== 'deleted' && missing
    if (f.status === 'deleted') return status === 'deleted'
    return true
  }

  function allRows() {
    var body = $('list-body')
    return body ? body.querySelectorAll('tr[data-id]') : []
  }

  function updateEmpty() {
    var box = $('list-empty')
    if (!box) return
    var rows = allRows()
    var visible = 0
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].classList.contains('row-hidden')) visible++
    }
    box.hidden = visible > 0
  }

  /** @param {boolean} syncUrl 是否同步地址栏（首屏加载传 false，避免多一条历史记录） */
  function applyFilter(syncUrl) {
    var f = currentFilter()
    var rows = allRows()

    for (var i = 0; i < rows.length; i++) {
      var show = rowMatches(rows[i], f)
      rows[i].classList.toggle('row-hidden', !show)
      if (show) {
        // 之前因为「刚操作完但不符合筛选」被淡化的行，重新可见时恢复原样
        rows[i].classList.remove('row-stale')
        rows[i].removeAttribute('title')
      }
    }
    updateEmpty()

    if (!syncUrl) return
    var params = []
    if (f.platform !== 'all') params.push('platform=' + encodeURIComponent(f.platform))
    if (f.status !== 'all') params.push('status=' + encodeURIComponent(f.status))
    try {
      history.replaceState(null, '', location.pathname + (params.length ? '?' + params.join('&') : ''))
    } catch (e) { /* 不支持时忽略，不影响筛选本身 */ }
  }

  /**
   * 改完状态后，若已不符合当前筛选，把行淡化并说明原因。
   * 为什么不直接隐藏：用户刚点的就是这一行，立刻消失等于「操作完看不见结果」。
   * 留到下次切筛选再隐藏，既给了反馈，又不破坏筛选语义。
   */
  function refreshStale(tr, status) {
    if (rowMatches(tr, currentFilter())) {
      tr.classList.remove('row-stale')
      tr.removeAttribute('title')
      return
    }
    tr.classList.add('row-stale')
    tr.title = '已' + (status === 'yanked' ? '撤回' : '恢复') + '，不在当前筛选内，切换筛选后不再显示'
  }

  function patchStatus(id, status, btn) {
    var tr = btn.closest('tr')
    btn.disabled = true
    fetch('/api/releases/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d } })
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || '操作失败')
        if (!tr) {
          // 找不到行（理论上不会）才退回整页刷新，保证状态一定同步
          btn.disabled = false
          location.reload()
          return
        }
        try {
          applyStatus(tr, res.data.status)
          refreshStale(tr, res.data.status)
          flashRow(tr)
        } catch (e) {
          // 行内更新失败（DOM 结构与预期不符）时退回刷新：
          // 宁可跳一下，也不能让用户以为操作没生效
          location.reload()
        }
      })
      .catch(function (err) {
        btn.disabled = false
        alert(err.message)
      })
  }

  /**
   * 删除成功后只把这一行从 DOM 摘掉，同时把状态条的两个数字减掉，
   * 口径与后端 /admin 的 summary 一致：墓碑不计入版本总数，也不计入占用。
   */
  function removeRow(tr, btn) {
    var size = Number(tr.getAttribute('data-size') || 0)
    var missing = tr.getAttribute('data-missing') === '1'

    tr.parentNode.removeChild(tr)

    var vEl = $('stat-versions')
    if (vEl) vEl.textContent = String(Math.max(0, Number(vEl.textContent || 0) - 1))

    if (!missing) {
      var oEl = $('stat-occupied')
      if (oEl) {
        var left = Math.max(0, Number(oEl.getAttribute('data-bytes') || 0) - size)
        oEl.setAttribute('data-bytes', String(left))
        oEl.textContent = fmtBytes(left)
      }
    }

    // 删到当前筛选一行不剩时给出占位，否则只剩表头看着像页面坏了
    updateEmpty()
    if (btn) btn.disabled = false
  }

  // 删除：二次确认即可，不再要求手打版本号。
  // 为什么改：手打版本号只是复制粘贴的负担，拦不住误操作（人会无脑粘），
  // 真正起作用的是「弹框 + 把后果写全 + 给出可逆的替代方案」。
  // 文案里必须带上 版本 + 平台 + 架构，让人能一眼核对自己删的是哪一条。
  function deleteRelease(id, combo, version, btn) {
    var label = version + (combo ? '（' + combo + '）' : '')
    var ok = window.confirm(
      '确定删除 ' + label + ' ？\n\n' +
        '· 文件立即从磁盘删除，不可恢复\n' +
        '· 该版本号作废，以后不能再上传同版本号\n' +
        '· 如果只是想下架，请点「撤回」——撤回可逆，文件也保留'
    )
    if (!ok) return

    var tr = btn.closest('tr')
    btn.disabled = true
    fetch('/api/releases/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d } })
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || '删除失败')
        if (tr) removeRow(tr, btn)
        else location.reload()
      })
      .catch(function (err) {
        btn.disabled = false
        alert('删除失败：' + err.message)
      })
  }

  /**
   * 校验磁盘上的包是否还等于上传时那份（服务端重算 sha256，几百 MB 要等一两秒）。
   * 为什么要人工点：整包重算会把磁盘 IO 翻倍，不适合挂在每次下载上。
   * 什么时候该点：怀疑磁盘坏、文件被人手工换过、用户反馈「装不上 / 包不完整」。
   */
  function verifyRelease(id, btn) {
    var label = btn.textContent
    btn.disabled = true
    btn.textContent = '校验中…'
    fetchJson('/api/releases/' + encodeURIComponent(id) + '/integrity')
      .then(function (d) {
        if (d.ok) {
          alert('校验通过\n\n' + d.version + ' ' + d.combo + '\n' +
            '大小 ' + fmtBytes(d.size_on_disk) + '（与记录一致）\n' +
            'sha256 ' + d.expected)
          return
        }
        if (d.reason === 'missing') {
          alert('文件已不存在\n\n' + d.version + ' ' + d.combo +
            '\n请用「重新上传」补齐同版本文件。')
          return
        }
        alert('校验不通过\n\n' + d.version + ' ' + d.combo + '\n' +
          '记录大小 ' + fmtBytes(d.size_recorded) + ' / 磁盘实际 ' + fmtBytes(d.size_on_disk) + '\n' +
          '记录 sha256 ' + d.expected + '\n' +
          '实际 sha256 ' + d.actual + '\n\n' +
          '这份文件已不能下载（下载直链会直接拒绝）。\n' +
          '处理办法：删除该版本后重新上传同一版本号。')
      })
      .catch(function (err) {
        alert('校验失败：' + err.message)
      })
      .then(function () {
        btn.disabled = false
        btn.textContent = label
      })
  }

  document.addEventListener('click', function (e) {
    var btn = closestAction(e.target)
    if (!btn) return
    var action = btn.getAttribute('data-action')

    if (action === 'reupload') {
      fVersion.value = btn.getAttribute('data-version') || ''
      fPlatform.value = btn.getAttribute('data-platform') || fPlatform.value
      renderArchs(btn.getAttribute('data-arch'))
      saveMem()
      updateCoverage()
      dz.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    var id = btn.getAttribute('data-id')
    if (!id) return

    if (action === 'yank') patchStatus(id, 'yanked', btn)
    else if (action === 'restore') patchStatus(id, 'active', btn)
    else if (action === 'verify') verifyRelease(id, btn)
    else if (action === 'delete') {
      deleteRelease(
        id,
        btn.getAttribute('data-combo') || '',
        btn.getAttribute('data-version') || '',
        btn
      )
    }
  })

  // 筛选：全部在前端完成，不提交表单、不刷新页面。
  // 表单仍保留 method=get（JS 被禁时还能用），但这里拦掉默认提交。
  var filterForm = $('filter-form')
  if (filterForm) {
    filterForm.addEventListener('submit', function (e) {
      e.preventDefault()
      applyFilter(true)
    })
    Array.prototype.forEach.call(filterForm.querySelectorAll('select'), function (s) {
      s.addEventListener('change', function () { applyFilter(true) })
    })
  }
  // 首屏不重算 URL：服务端已经按 URL 参数打好了 row-hidden，这里只补空态兜底
  applyFilter(false)

  // 上传成功后高亮新增行 3 秒
  var flashId = null
  try {
    flashId = sessionStorage.getItem('online-exe-flash')
    if (flashId) sessionStorage.removeItem('online-exe-flash')
  } catch (e4) { /* ignore */ }

  if (flashId) {
    var tr = document.querySelector('tr[data-id="' + flashId + '"]')
    if (tr) {
      tr.classList.add('row-flash')
      setTimeout(function () { tr.classList.remove('row-flash') }, 3000)
    }
  }

  // ── 孤儿文件：懒加载 / 单个删除 / 全部清理 ─────────────────────────────
  // 孤儿 = 磁盘上有、版本记录里没有的文件（启动对账把它们移入 data/orphan/ 待确认）。
  // 这块内容平时没人看，所以默认折叠、点「查看」才请求，不占首屏。
  var orphanToggle = $('orphan-toggle')
  var orphanPanel = $('orphan-panel')
  var orphanBody = $('orphan-body')
  var orphanClear = $('orphan-clear')
  var orphanCountEl = $('orphan-count')
  var orphanBytesEl = $('orphan-bytes')
  var orphanLoaded = false

  /**
   * 统一取 JSON 并处理错误。
   * 注意 404（路由没命中）返回的是纯文本，JSON.parse 会抛，必须降级成 { error: 文本 }，
   * 否则这里会抛一个和真实原因无关的 SyntaxError。
   */
  function fetchJson(url, options) {
    return fetch(url, options).then(function (r) {
      return r.text().then(function (text) {
        var data = {}
        try { data = text ? JSON.parse(text) : {} } catch (e2) { data = { error: text || ('HTTP ' + r.status) } }
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status))
        return data
      })
    })
  }

  /** 把一句话塞进孤儿面板（用于空态、加载中、错误提示） */
  function setOrphanHint(text, isError) {
    orphanBody.innerHTML = ''
    var p = document.createElement('p')
    p.className = isError ? 'empty err' : 'empty'
    p.textContent = text
    orphanBody.appendChild(p)
  }

  /** 状态条上的个数与大小跟着列表同步，省一次整页刷新 */
  function syncOrphanStat(count, bytes) {
    if (orphanCountEl) orphanCountEl.textContent = count + ' 个'
    if (orphanBytesEl) orphanBytesEl.textContent = '/ ' + fmtBytes(bytes)
  }

  /** 渲染孤儿列表。全部走 textContent —— 文件名来自磁盘，可能含尖括号，绝不能当 HTML 拼 */
  function renderOrphans(data) {
    syncOrphanStat(data.count, data.bytes)

    if (!data.orphans || data.orphans.length === 0) {
      setOrphanHint('没有孤儿文件。', false)
      return
    }

    orphanBody.innerHTML = ''
    var table = document.createElement('table')
    table.className = 'table'
    var thead = document.createElement('thead')
    thead.innerHTML = '<tr><th>路径（相对 data/orphan/）</th><th>大小</th><th>移入时间</th><th>操作</th></tr>'
    table.appendChild(thead)

    var tbody = document.createElement('tbody')
    data.orphans.forEach(function (f) {
      var tr = document.createElement('tr')

      var tdPath = document.createElement('td')
      tdPath.className = 'orphan-path'
      tdPath.textContent = f.path
      tr.appendChild(tdPath)

      var tdSize = document.createElement('td')
      tdSize.textContent = fmtBytes(f.size)
      tr.appendChild(tdSize)

      var tdTime = document.createElement('td')
      // 服务端给的是 UTC ISO 串，浏览器按本地时区渲染，与页面其他地方口径一致
      tdTime.textContent = new Date(f.mtime).toLocaleString()
      tr.appendChild(tdTime)

      var tdOp = document.createElement('td')
      tdOp.className = 'ops'
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-sm btn-danger'
      btn.textContent = '删除'
      btn.addEventListener('click', function () {
        removeOrphan(f.path, btn)
      })
      tdOp.appendChild(btn)
      tr.appendChild(tdOp)

      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    orphanBody.appendChild(table)
  }

  function loadOrphans() {
    setOrphanHint('加载中…', false)
    return fetchJson('/api/orphans')
      .then(renderOrphans)
      .catch(function (err) { setOrphanHint('加载失败：' + err.message, true) })
  }

  /** 删单个：孤儿不在任何版本记录里，删掉就是真没了，所以要确认一次 */
  function removeOrphan(path, btn) {
    if (!window.confirm('删除该孤儿文件？\n' + path + '\n\n它不在任何版本记录里，删除后不可恢复。')) return
    btn.disabled = true
    fetchJson('/api/orphans?path=' + encodeURIComponent(path), { method: 'DELETE' })
      .then(function () { return loadOrphans() })
      .catch(function (err) {
        btn.disabled = false
        window.alert('删除失败：' + err.message)
      })
  }

  if (orphanToggle && orphanPanel) {
    orphanToggle.addEventListener('click', function () {
      var opening = orphanPanel.hidden
      orphanPanel.hidden = !opening
      orphanToggle.textContent = opening ? '收起' : '查看'
      // 首次展开才请求；收起再展开不重复拉，点「删除」后会主动重新拉
      if (opening && !orphanLoaded) {
        orphanLoaded = true
        loadOrphans()
      }
    })
  }

  if (orphanClear) {
    orphanClear.addEventListener('click', function () {
      var n = orphanCountEl ? orphanCountEl.textContent : ''
      if (!window.confirm('清空全部孤儿文件（当前 ' + n + '）？\n这些文件不在任何版本记录里，删除后不可恢复。')) return
      orphanClear.disabled = true
      fetchJson('/api/orphans', { method: 'DELETE' })
        .then(function (res) {
          window.alert('已清理 ' + res.removed + ' 个文件，释放 ' + fmtBytes(res.bytes))
          // 清空是全局动作，状态条与列表一起刷新最省事
          location.reload()
        })
        .catch(function (err) {
          orphanClear.disabled = false
          window.alert('清理失败：' + err.message)
        })
    })
  }

  // ── 下载次数自动刷新 ────────────────────────────────────────────
  // 这一列是服务端渲染的，用户去客户端下载完再回来，不刷新页面就永远看到旧值，
  // 很容易被当成「统计不到」。这里每 10 秒拉一次 /api/stats 就地改单元格，
  // 不动筛选、不动滚动位置；切回标签页时立刻补一次。
  var COUNT_POLL_MS = 10000
  var countTimer = null

  function applyCounts(counts) {
    var rows = allRows()
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-id')
      var cell = rows[i].querySelector('.cell-downloads')
      if (!id || !cell) continue
      var n = counts[id] || 0
      if (cell.textContent !== String(n)) cell.textContent = String(n)
    }
  }

  function pollCounts() {
    if (document.hidden) return
    fetchJson('/api/stats')
      .then(function (res) { applyCounts((res && res.counts) || {}) })
      .catch(function () { /* 网络抖动忽略，下一轮再试 */ })
  }

  if (allRows().length > 0) {
    countTimer = setInterval(pollCounts, COUNT_POLL_MS)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) pollCounts()
    })
    // 卸载时清掉，避免 bfcache 里留一个还在跑的定时器
    window.addEventListener('pagehide', function () {
      if (countTimer) { clearInterval(countTimer); countTimer = null }
    })
  }
})()
