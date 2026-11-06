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
  var progressWrap = $('progress-wrap')
  var progressBar = $('progress-bar')
  var uploadMeta = $('upload-meta')
  var formTip = $('form-tip')
  var channelTag = $('channel-tag')
  var coverageEl = $('coverage')
  var submitBtn = $('submit-btn')

  var selectedFile = null
  var uploading = false

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
    selectedFile = file || null
    dzFile.textContent = selectedFile
      ? selectedFile.name + ' · ' + fmtBytes(selectedFile.size)
      : ''
  }

  function fail(msg) {
    formTip.className = 'form-tip err'
    formTip.textContent = msg
  }

  function resetButton() {
    uploading = false
    submitBtn.disabled = false
    submitBtn.textContent = '开始上传'
  }

  // 初始化：恢复表单记忆
  var mem = readMem()
  if (mem.platform) fPlatform.value = mem.platform
  renderArchs(mem.arch)
  if (mem.version) fVersion.value = mem.version
  updateCoverage()

  fPlatform.addEventListener('change', function () {
    renderArchs(null)
    saveMem()
    updateCoverage()
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

    var url = '/api/releases?version=' + encodeURIComponent(version) +
      '&platform=' + encodeURIComponent(platform) +
      '&arch=' + encodeURIComponent(arch)

    var fd = new FormData()
    fd.append('changelog', changelog)
    fd.append('file', selectedFile)

    uploading = true
    submitBtn.disabled = true
    submitBtn.textContent = '上传中…'
    formTip.className = 'form-tip'
    formTip.textContent = ''
    progressWrap.classList.add('show')
    progressBar.style.width = '0%'
    uploadMeta.textContent = '准备上传 ' + fmtBytes(selectedFile.size)

    var xhr = new XMLHttpRequest()
    xhr.open('POST', url, true)

    var startedAt = Date.now()
    xhr.upload.onprogress = function (ev) {
      if (!ev.lengthComputable) return
      var pct = ev.loaded / ev.total * 100
      progressBar.style.width = pct.toFixed(1) + '%'
      var sec = (Date.now() - startedAt) / 1000
      var speed = sec > 0 ? ev.loaded / sec : 0
      uploadMeta.textContent = pct.toFixed(1) + '% · ' +
        fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total) + ' · ' +
        fmtBytes(speed) + '/s'
    }

    xhr.onload = function () {
      resetButton()
      var data = {}
      try { data = JSON.parse(xhr.responseText || '{}') } catch (e2) { /* ignore */ }

      if (xhr.status === 201) {
        progressBar.style.width = '100%'
        uploadMeta.textContent = '上传成功 · sha256 ' + String(data.sha256 || '').slice(0, 8)
        formTip.className = 'form-tip ok'
        formTip.textContent = '已发布 ' + data.version + ' / ' + data.platform + ' / ' + data.arch
        setFile(null)
        fFile.value = ''
        try { sessionStorage.setItem('online-exe-flash', data.id || '') } catch (e3) { /* ignore */ }
        setTimeout(function () { location.reload() }, 900)
        return
      }

      if (xhr.status === 409 && data && data.error) {
        fail(data.error)
        if (data.existing && data.existing.version) {
          var next = bumpPatch(data.existing.version)
          if (next) {
            fVersion.value = next
            saveMem()
            updateCoverage()
            formTip.textContent = data.error + '，已自动改为 ' + next
          }
        }
        return
      }

      fail((data && data.error) || ('上传失败（HTTP ' + xhr.status + '）'))
    }

    xhr.onerror = function () {
      resetButton()
      fail('网络中断，上传失败，请重试（临时文件已清理）')
    }

    xhr.send(fd)
  })

  // 行操作：撤回 / 恢复 / 删除 / 重新上传
  function closestAction(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-action')) return node
      node = node.parentNode
    }
    return null
  }

  function patchStatus(id, status, btn) {
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
        location.reload()
      })
      .catch(function (err) {
        btn.disabled = false
        alert(err.message)
      })
  }

  function deleteRelease(id, version, btn) {
    var input = prompt(
      '删除后该版本号作废，不可再上传同版本。\n请输入版本号 ' + version + ' 确认删除：'
    )
    if (input === null) return
    if (normalize(input) !== version) {
      alert('版本号不一致，已取消')
      return
    }
    btn.disabled = true
    fetch('/api/releases/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d } })
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || '删除失败')
        location.reload()
      })
      .catch(function (err) {
        btn.disabled = false
        alert(err.message)
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
    else if (action === 'delete') deleteRelease(id, btn.getAttribute('data-version') || '', btn)
  })

  // 筛选器变更即提交
  var filterForm = $('filter-form')
  if (filterForm) {
    Array.prototype.forEach.call(filterForm.querySelectorAll('select'), function (s) {
      s.addEventListener('change', function () { filterForm.submit() })
    })
  }

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
})()
