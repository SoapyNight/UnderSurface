/* ============================================================================
   engine.js —— UnderSurface 游戏引擎
   ----------------------------------------------------------------------------
   职责：
     1. 舞台等比缩放（960×720 固定坐标系）
     2. 场景切换 + 柔和黑幕/亮幕转场
     3. 主角左右移动、行走动画、场景出口
     4. 交互热点 / NPC / 动态物件（公交车）
     5. 对话框、通用面板
     6. 电脑（内嵌 art/web/*.html 真实网页）与手机
     7. 线索 / 成就 / 存档读档 / 结局判定

   data.js 中的热点通过 g.xxx() 调用本引擎，接口集中在"对外接口"一节。
   ========================================================================== */

window.Game = (function () {
  'use strict';

  var D = window.GAME_DATA;

  /* ------------------------------------------------------------------ 常量 */
  var STAGE_W = 960;
  var STAGE_H = 720;

  var HERO_W = 200;            // 主角容器宽（sprite 用 contain 保持比例，须容纳行走帧宽）
  var HERO_H = 380;            // 主角基准高（室内近景比例，其余场景按 SCENE_SCALE 缩放）
  var SPEED = 210;             // 移动速度 px/秒
  var NEAR_PAD = 40;           // 靠近判定余量：角色需在可交互点中心 ±(半宽+余量) 内才能交互/出现提示

  /* 各场景的人物缩放：室内近景为基准 1，户外/远景透视更远，人物需相应缩小。
     未列出的场景（如 home）默认 1；NPC 也按同一系数缩放，保持人景比例一致。
     注：shop 的背景图里已画入一位成年店员（近景站位），故主角不缩小，保持与背景店员相当的尺寸。 */
  var SCENE_SCALE = {
    home: 1.18,
    busstop: 0.64,
    downstairs: 0.58,
    path: 0.60, resident: 0.64, gate: 0.60,
    scenic: 0.58, minecart: 0.58,
    cave_mouth: 0.58, shop: 1.20,
    mine_shaft: 0.58, mine_abandoned: 0.58, mine_hub: 0.58,
    mine_lamp: 0.58, mine_flood: 0.58, mine_ore: 0.58,
    museum_out: 0.60, museum_in: 0.72
  };
  function sceneScale(id) { return SCENE_SCALE[id] || 1; }

  var RESIDENT_FIG_H = 322;   // 居民区「随机采访」立绘的基准高（未乘场景系数，人景比例同原常驻 NPC）

  /* 矿洞深处的六个区域：走遍即解锁「井下巡线」成就（见 visitRoom） */
  var MINE_ROOMS = ['mine_shaft', 'mine_abandoned', 'mine_hub',
                    'mine_lamp', 'mine_flood', 'mine_ore'];

  /* 按日期计算当日体力：周日 3 点，其余 1 点（体力制，见 data.js STAMINA） */
  function staminaForDate(d) {
    return new Date(d.y, d.m - 1, d.d).getDay() === 0 ? D.STAMINA.SUNDAY : D.STAMINA.WEEKDAY;
  }

  /* 每日起始时刻：按星期决定（见流程图）
     周一~周五 21:00~22:00、周六 18:00~19:00、周日 08:00~09:00 */
  function randStartMinutes(date) {
    var d = date || D.START_DATE;
    var wd = new Date(d.y, d.m - 1, d.d).getDay();   // 0 = 周日
    var base = wd === 0 ? 8 * 60 : (wd === 6 ? 18 * 60 : 21 * 60);
    return base + Math.floor(Math.random() * 60);    // 起始整点后的 0~59 分钟
  }

  /* 时间系统：不再随现实时间流动，改由玩家的有效操作推进。
     一次场景转换 / 一次玩家交互 / 一次网页跳转各推进一点时间；跨过 24:00 即强制结束当天探索。 */
  var TIME_PER_SCENE = 10;     // 一次场景转换推进的分钟数
  var TIME_PER_TALK = 5;       // 一次玩家交互（内心独白 / 场景交互 / NPC 对话）推进的分钟数
  var TIME_PER_WEB = 5;        // 一次网页跳转推进的分钟数
  var DAY_END = 24 * 60;       // 24:00 强制结束当天

  /* 暂停并复位一条音轨（媒体 API 在无头环境可能不可用） */
  function resetAudio(a) {
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch (e) {}
  }

  /* 手机主屏上的 11 个唯一应用（微信在 Dock 有第二个热区，只算一个） */
  var PHONE_APPS = [
    'wechat', 'qq', 'browser', 'settings', 'gallery', 'recorder',
    'music', 'clock', 'phone', 'sms', 'camera'
  ];
  var PHONE_APP_TITLES = {
    phone: '电话', sms: '信息', wechat: '微信', qq: 'QQ空间', gallery: '相册',
    recorder: '录音机', music: '音乐', clock: '时钟', camera: '相机',
    settings: '设置', browser: '浏览器'
  };
  /* 音乐 App 的封面：复用游戏内已有素材，保证与整体画风一致 */
  var PHONE_COVERS = ['../art/室内.png', '../art/景区风景3.png'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* 把分钟数折算成 HH:MM（自动跨日回绕） */
  function clockHM(minutes) {
    var m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  /* 秒数 → MM:SS（音乐 / 录音计时用） */
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
  }
  var WALK_INTERVAL = 90;      // 行走帧切换间隔 ms
  var FAST_ADV = 0.12;         // 按住 Ctrl 时对话自动推进的间隔（秒）

  var IDLE_SPRITE = 'assets/gen/hero_idle.png';
  var WALK_FRAMES = [
    'assets/gen/walk_1.png', 'assets/gen/walk_2.png',
    'assets/gen/walk_3.png', 'assets/gen/walk_4.png',
    'assets/gen/walk_5.png', 'assets/gen/walk_6.png',
    'assets/gen/walk_7.png', 'assets/gen/walk_8.png'
  ];

  var K_SAVE = 'undersurface.save.';
  var K_AUTO = 'undersurface.auto';
  var K_META = 'undersurface.meta';
  var K_SEEN = 'undersurface.seen';   // 已读对话行记录（用于「跳过已读」）
  var K_KEYS = 'undersurface.keys';   // 可自定义的按键映射
  var SLOTS = 3;               // 手动存档位数量

  /* 背景音乐：室内场景用公寓配乐，其余（室外）用 sunset-drift */
  var BGM_VOLUME = 0.45;
  var INDOOR_SCENES = { home: 1, museum_in: 1 };

  /* 导览图上可进入的「场馆」：从导览图进入算一次探索，返回导览图 / 回家时结算 1 点体力 */
  var VENUE_SCENES = { minecart: 1, cave_mouth: 1, shop_out: 1, museum_out: 1 };

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /* 对话行的稳定标识：说话人 + 文本 的 djb2 哈希（用于「已读」记录） */
  function lineKey(line) {
    var s = (line.s || '') + '|' + (line.t || '');
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'l' + (h >>> 0);
  }

  /* 按键归一化：字母统一小写，其余取原始名的小写 */
  function normKey(k) { return String(k).toLowerCase(); }

  /* 高精度时间戳：用于可暂停计时器记录剩余时间 */
  function nowMs() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  /* 默认按键映射（可被玩家自定义覆盖） */
  var DEFAULT_KEYS = { interact: 'j' };

  /* 保留键：移动 / 推进 / 加速 / 返回 / 底栏 / 开发者工具等，不允许被占用 */
  var RESERVED_KEYS = {
    'a': 1, 'd': 1, 'arrowleft': 1, 'arrowright': 1,
    ' ': 1, 'enter': 1, 'control': 1, 'escape': 1,
    'f': 1, 'tab': 1, 'f12': 1
  };

  /* --------------------------------------------------------------- DOM 缓存 */
  var el = {};
  function cacheDom() {
    el.viewport = document.getElementById('viewport');
    el.stage = document.getElementById('stage');
    el.sceneBg = document.getElementById('scene-bg');
    el.hotspotLayer = document.getElementById('hotspot-layer');
    el.propLayer = document.getElementById('prop-layer');
    el.npcLayer = document.getElementById('npc-layer');
    el.hero = document.getElementById('hero');
    el.sprite = document.getElementById('hero-sprite');
    el.prompt = document.getElementById('prompt');

    el.hud = document.getElementById('hud');
    el.hudDate = document.getElementById('hud-date');
    el.hudTime = document.getElementById('hud-time');
    el.hudDay = document.getElementById('hud-day');
    el.hudStamina = document.getElementById('hud-stamina');
    el.hudMenu = document.getElementById('hud-menu');
    el.mapBack = document.getElementById('map-back');

    el.bottombar = document.getElementById('bottombar');
    el.barToggle = document.getElementById('bar-toggle');
    el.barItems = document.getElementById('bar-items');
    el.barThink = document.getElementById('bar-think');
    el.barHome = document.getElementById('bar-home');
    el.barNextday = document.getElementById('bar-nextday');

    el.dialogue = document.getElementById('dialogue');
    el.dlgAvatar = document.getElementById('dlg-avatar');
    el.dlgName = document.getElementById('dlg-name');
    el.dlgText = document.getElementById('dlg-text');
    el.dlgSkip = document.getElementById('dlg-skip');
    el.dlgPortrait = document.getElementById('dlg-portrait');
    el.dlgPortraitImg = document.getElementById('dlg-portrait-img');

    el.panel = document.getElementById('panel');
    el.panelTitle = document.getElementById('panel-title');
    el.panelBody = document.getElementById('panel-body');
    el.panelClose = document.getElementById('panel-close');

    el.computer = document.getElementById('computer');
    el.compUrl = document.getElementById('computer-url');
    el.compView = document.getElementById('computer-view');
    el.compNet = document.getElementById('computer-net');
    el.compClose = document.getElementById('computer-close');
    el.compBack = document.getElementById('computer-back');

    el.phone = document.getElementById('phone');
    el.phoneClose = document.getElementById('phone-close');
    el.phoneHome = document.getElementById('phone-home');
    el.phoneStatusTime = document.getElementById('phone-status-time');
    el.phoneBrowser = document.getElementById('phone-browser');
    el.phoneApp = document.getElementById('phone-app');
    el.phoneAppBack = document.getElementById('phone-app-back');
    el.phoneAppTitle = document.getElementById('phone-app-title');
    el.phoneAppBody = document.getElementById('phone-app-body');
    el.phoneMusic = document.getElementById('phone-music');
    el.phoneBack = document.getElementById('phone-back');
    el.phoneBackPage = document.getElementById('phone-back-page');
    el.phoneUrl = document.getElementById('phone-url');
    el.phoneView = document.getElementById('phone-view');

    el.toast = document.getElementById('toast');
    el.curtain = document.getElementById('curtain');
    el.fx = document.getElementById('fx');
    el.fxScare = document.getElementById('fx-scare');
    el.bgmIndoor = document.getElementById('bgm-indoor');
    el.bgmOutdoor = document.getElementById('bgm-outdoor');
    el.bgmTitle = document.getElementById('bgm-title');
    el.title = document.getElementById('title');
    el.splash = document.getElementById('splash');
    el.page = document.getElementById('page');
    el.pageTitle = document.getElementById('page-title');
    el.pageBody = document.getElementById('page-body');
    el.pageClose = document.getElementById('page-close');
  }

  /* 预加载用的 Image 引用：必须保留，否则已解码的位图可能被回收；
     配合 img.decode() 主动预解码，保证首次换帧时不用等解码。 */
  var preloaded = [];

  /* =================================================================== 引擎 */
  var Game = {

    /* ------------------------------------------------------------ 生命周期 */
    boot: function () {
      cacheDom();
      this._keys = { left: false, right: false };
      this._stTimers = [];   // 可暂停计时器列表（场景演出：公交车 / 动态物件 / 延时事件）
      this._stPaused = false; // 当前是否已冻结场景演出（面板 / 对话等界面打开时）
      this._lock = false;
      this._ending = false;
      this._inGame = false;
      this._restPending = false;         // 体力耗尽待强制休息
      this._timeEnding = false;          // 时间跨过 24:00 待强制结束当天
      this._webCharged = false;          // 浏览器：本次会话的调查点数是否已扣
      this._venuePending = false;        // 户外：已探索场馆但尚未回到导览图结算
      this._audioUnlocked = false;       // 是否已获得用户手势（解锁有声播放）
      this._page = '';
      this._dev = null;               // 当前页面是否可 F12 打开「网络」面板
      this._compHist = [];            // 电脑浏览器：浏览过的页面栈
      this._compIdx = -1;             // 电脑浏览器：当前页在栈中的位置
      this._phoneHist = [];           // 手机浏览器：浏览过的页面栈
      this._phoneIdx = -1;            // 手机浏览器：当前页在栈中的位置
      this._webApplied = { comp: '', phone: '' };  // 已处理过的网页名（iframe load 与网页自报两路去重）
      this._webClueWatch = null;      // 有线索的网页：等待「滚动发现」的线索待发信息
      this._pendingRemarks = [];      // 线索内心独白缓冲：等下一次 say() 一起播出
      this._queue = [];               // 当前对白播放队列（首次 say() 前也保持有值）
      this._portrait = '';            // 当前对话立绘路径（空 = 不显示立绘）
      this._portraitMuted = false;    // 临时禁立绘（序章电话演出：只出头像）
      this._walkFrame = 0;
      this._walkT = 0;
      this._curSprite = '';
      this._last = 0;
      this._seen = this.loadSeen();   // 已读对话行
      this._keyMap = this.loadKeys(); // 可自定义按键映射（交互键等）
      this._rebind = null;            // 改键捕获态：非 null 时下一次按键即写入
      this._ctrlHeld = false;         // 是否按住 Ctrl 加速对话
      this._fastT = 0;
      this._bgm = null;               // 当前播放的背景音乐元素
      this._idleT = 0;                // 静置计时（秒）
      this._thinkCount = 0;           // 「深度思考」连续按下次数的计数
      this._lastThink = 0;
      this._endings = this.readMeta().endings || 0;   // 已达成结局次数（跨周目，用于解锁深度思考）
      this._nearList = [];            // 当前位置范围内全部可交互点（按距离排序）
      this._nearPick = null;          // 多选面板中待选的可交互点列表
      this._paApp = '';               // 手机：当前打开的应用
      this._paSub = '';               // 手机：应用内的二级页（thread / view / player / incall）
      this._paTab = '';               // 手机 · 电话 App：当前小标签（recents / contacts / dial）
      this._paDigits = '';            // 手机 · 拨号盘：已输入号码
      this._paConv = -1;              // 手机：当前打开的会话下标（短信 / 微信）
      this._paPhoto = -1;             // 手机 · 相册：当前查看的照片下标
      this._paIdx = -1;               // 手机 · 音乐：当前曲目下标
      this._paPlaying = false;        // 手机 · 音乐：是否正在播放
      this._paTimer = null;           // 手机 · 音乐：进度刷新计时器
      this._paRecTimer = null;        // 手机 · 录音机：录音计时器
      this._paRecSec = 0;             // 手机 · 录音机：已录制秒数
      this._paCallTimer = null;       // 手机 · 电话：通话计时器
      this._paCallWho = '';           // 手机 · 电话：当前通话对象
      this._paCallSec = 0;            // 手机 · 电话：通话秒数
      this._bgmDucked = false;        // 手机听歌时暂挂场景配乐，停播后接回
      this._titleBgmWanted = false;   // 标题曲是否应处于播放态（用于首次交互补播）
      [el.bgmIndoor, el.bgmOutdoor, el.bgmTitle].forEach(function (a) { if (a) a.volume = BGM_VOLUME; });

      this.state = this.newState();
      this.applyOpts();
      this._loopBound = this.loop.bind(this);

      this.resize();
      this.bindGlobal();
      this.preload();
      this.updateHud();

      var self = this;
      el.bottombar.classList.add('hidden');

      // 开场：团队 LOGO → 标题页
      this.showSplash(function () { self.showTitle(); });

      requestAnimationFrame(this._loopBound);
    },

    /* 舞台等比缩放 */
    resize: function () {
      var s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      el.stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
    },

    preload: function () {
      var urls = [IDLE_SPRITE].concat(WALK_FRAMES);
      Object.keys(D.SCENES).forEach(function (id) {
        var bg = D.SCENES[id].bg;
        if (typeof bg === 'string') urls.push(bg);
        (D.SCENES[id].npcs || []).forEach(function (n) { urls.push(n.img); });
      });
      urls.push('../art/室内.png', '../art/室内_无猫.png', '../art/结局场景.png');
      urls.forEach(function (u) {
        var i = new Image();
        i.src = u;
        preloaded.push(i);                                 // 保留引用，避免解码结果被回收
        if (i.decode) i.decode().catch(function () {});     // 主动预解码，首次换帧不再等解码
      });
    },

    /* ------------------------------------------------------------ 状态模型 */
    newState: function () {
      return {
        date: { y: D.START_DATE.y, m: D.START_DATE.m, d: D.START_DATE.d },
        day: 1,
        minutes: randStartMinutes(D.START_DATE),
        stamina: staminaForDate(D.START_DATE),
        scene: 'home',
        x: D.SCENES.home.start,
        facing: 1,
        clues: {},
        achv: {},
        flags: {},
        entryX: {},  // 各场景离开时的站位，返回该场景时回到原处
        rooms: {},   // 矿洞深处：到访过的区域（走遍六区解锁成就）
        apps: {},    // 手机：已打开过的应用（收藏类成就用）
        shots: [],   // 手机 · 相机：拍摄的照片 { img, c }
        clips: [],   // 手机 · 录音机：现场录下的备忘 { n, t }
        opts: { vol: BGM_VOLUME, bright: 1, mute: false, airplane: false }  // 手机设置
      };
    },

    /* 读档时补齐缺失字段，避免旧存档崩溃 */
    normalizeState: function (s) {
      var fresh = this.newState();
      for (var k in fresh) if (!(k in s)) s[k] = fresh[k];
      return s;
    },

    state: null,

    /* =========================================================== 转场 ==== */
    /* 柔和黑幕 → 执行 mid() → 亮幕；期间锁定操作 */
    fade: function (mid, done) {
      var self = this;
      if (this._lock) return;
      this._lock = true;
      el.curtain.classList.add('on');
      setTimeout(function () {
        // mid() 内部可能因数据问题抛错；用 try/catch 兜住，保证转场流程与 _lock 一定释放
        try {
          if (mid) mid();
        } catch (e) {
          if (window.console && console.error) console.error(e);
        }
        setTimeout(function () {
          el.curtain.classList.remove('on');
          setTimeout(function () {
            self._lock = false;
            self.syncScenePause();
            if (done) done();
          }, 480);
        }, 140);
      }, 520);
    },

    /* 切场快闪：比 fade 短促得多，用于「换人 / 换位」不打断整体节奏 */
    cutIn: function (mid) {
      var self = this;
      if (this._lock) return;
      this._lock = true;
      el.curtain.classList.add('cutin');
      setTimeout(function () {
        try {
          if (mid) mid();
        } catch (e) {
          if (window.console && console.error) console.error(e);
        }
        setTimeout(function () {
          el.curtain.classList.remove('cutin');
          setTimeout(function () {
            self._lock = false;
            self.syncScenePause();
          }, 180);
        }, 110);
      }, 150);
    },

    /* =========================================================== 场景 ==== */
    goto: function (scene, opts) {
      var self = this;
      opts = opts || {};
      if (this._lock || this._ending) return;
      var target = D.SCENES[scene];
      if (!target) return;
      var from = this.state.scene;

      this.fade(function () {
        // 从导览图进入可探索的场馆 → 记下一次待结算的探索（赶路场景不扣体力）
        if (from === 'scenic' && VENUE_SCENES[scene]) self._venuePending = true;
        // 记住离开时所在场景的站位，之后返回该场景时回到原处
        if (from && from !== scene) self.state.entryX[from] = self.state.x;
        self.state.scene = scene;
        self.state.x = self.landingX(scene, opts);
        self.enterScene();
      }, function () {
        // 一次场景转换 → 推进游戏内时间（跨过 24:00 会强制结束当天）
        if (from && from !== scene) self.advanceTime(TIME_PER_SCENE);
        // 回到导览图 / 家中 → 结算本次场馆探索（体力耗尽时会给出室外 / 室内独白）
        if (scene === 'scenic' || scene === 'home') self._settleVenueVisit();
        // 体力耗尽后回到家中 → 强制休息，进入下一天
        if (scene === 'home') self.restIfExhausted();
      });
    },

    /* 进入 scene 时的落点：显式指定 > 从边缘走来的内缩落点 > 记忆站位 > 场景默认起点 */
    landingX: function (scene, opts) {
      if (opts.x != null) return opts.x;
      var target = D.SCENES[scene];
      // 走路越界转场：落点必须贴住「进入侧」（从左口进来落左侧、从右口进来落右侧），
      // 且内缩 40px。否则若沿用记忆站位落到对侧边缘，玩家按住的方向会在解锁后
      // 立刻把角色再次顶出边界，表现为「走到两边都会弹回上一个场景」。
      if (opts.edge === 'right') return target.walk[0] + 40;
      if (opts.edge === 'left') return target.walk[1] - 40;
      var memo = this.state.entryX[scene];
      if (memo != null) return memo;
      return target.start;
    },

    /* 走到场景边缘时切换到相邻场景，落点带一点内缩 */
    travel: function (dir) {
      var sc = D.SCENES[this.state.scene];
      if (!sc.exits || !sc.exits[dir]) return;
      var ex = sc.exits[dir];
      var target = D.SCENES[ex.to];
      if (!target) return;
      var opts = { edge: dir };
      if (ex.x != null) opts.x = ex.x;
      this.goto(ex.to, opts);
    },

    /* 一键回家：户外底栏按钮，直接回到公寓（室内场景无需使用） */
    goHome: function () {
      if (!this._inGame || this._ending || this._lock) return;
      if (this.dlgOpen() || this.panelOpen() || this.pageOpen() || this.computerOpen() ||
          !el.phone.classList.contains('hidden')) return;
      var sc = this.state.scene;
      if (!sc || INDOOR_SCENES[sc]) return;   // 已在室内，无需回家
      var self = this;
      this.say([{ s: 'hero', t: '（先回公寓吧，安静点，也好把线索理一理。）' }], function () {
        self.goto('home', { x: D.SCENES.home.start });
      });
    },

    enterScene: function () {
      var sc = D.SCENES[this.state.scene];
      this.clearTimers();
      this.clearAfters();
      this.fxClear();                   // 换场景时收起尚未演完的彩蛋特效
      this.applyOpts();                 // 手机设置（音量 / 静音）在每次进入场景时同步
      this.playBgm(this.state.scene);   // 按室内/室外切换配乐

      // 背景（可为函数，随 flag 变化）
      var bg = (typeof sc.bg === 'function') ? sc.bg(this) : sc.bg;
      var fit = sc.bgFit || {};
      el.sceneBg.style.backgroundImage = 'url("' + bg + '")';
      el.sceneBg.style.backgroundSize = fit.size || '100% 100%';
      el.sceneBg.style.backgroundPosition = fit.position || 'center center';
      this.applySceneFilter();

      if (sc.map) {
        // 导览图场景：不显示角色，改为鼠标点击区块移动
        el.hero.classList.add('hidden');
        if (el.mapBack) el.mapBack.classList.remove('hidden');
      } else {
        el.hero.classList.remove('hidden');
        this.placeHero();
        if (el.mapBack) el.mapBack.classList.add('hidden');
      }

      this.renderHotspots();
      this.renderNpcs();
      this.renderTimers();
      this.updateHud();
      this.autoSave();

      if (MINE_ROOMS.indexOf(this.state.scene) >= 0) this.visitRoom(this.state.scene);

      if (sc.onEnter) sc.onEnter(this);
    },

    /* ------------------------------------------------------- 热点渲染 --- */
    renderHotspots: function () {
      var self = this;
      var sc = D.SCENES[this.state.scene];
      el.hotspotLayer.innerHTML = '';
      this.resetPrompt();   // 节点重建，靠近状态随之失效
      if (!sc) return;   // 结局等无场景状态下不渲染热点

      (sc.hotspots || []).forEach(function (h) {
        if (h.when && !h.when(self)) return;
        var node = document.createElement('div');
        node.className = 'hotspot';
        node.style.left = h.x + 'px';
        node.style.top = h.y + 'px';
        node.style.width = h.w + 'px';
        node.style.height = h.h + 'px';

        // 地图场景：键盘交互改为鼠标悬停高亮 + 点击前往
        if (sc.map) {
          node.className = 'map-spot';
          node.innerHTML = '<span class="map-name">' + (h.tip || '') + '</span>';
          node.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (self._lock || self._ending) return;
            h.action(self);
            self.advanceTime(TIME_PER_TALK);   // 一次场景交互 → 推进时间
          });
          el.hotspotLayer.appendChild(node);
          return;
        }

        // 靠近判定数据：中心 x / 顶部 y / 触发半径 / 提示名 / 交互动词
        node._ix = { cx: h.x + h.w / 2, top: h.y, range: h.w / 2 + NEAR_PAD, name: h.tip || '', verb: h.verb || '调查' };
        // 交互动作：仅由键盘（J / 空格）在靠近时触发
        node._act = function () {
          if (self._lock || self._ending) return;
          if (!self.isNear(node)) return;
          h.action(self);
        };
        el.hotspotLayer.appendChild(node);
      });
    },

    /* ---------------------------------------------------------- NPC 渲染 */
    renderNpcs: function () {
      var self = this;
      var sc = D.SCENES[this.state.scene];
      el.npcLayer.innerHTML = '';
      this.resetPrompt();   // 节点重建，靠近状态随之失效
      if (!sc) return;   // 结局等无场景状态下不渲染 NPC

      var s = sceneScale(this.state.scene);
      (sc.npcs || []).forEach(function (n) {
        var nh = Math.round(n.h * s);
        var node = document.createElement('div');
        node.className = 'npc';
        node.style.left = n.x + 'px';
        node.style.top = (n.bottom - nh) + 'px';
        node.style.height = nh + 'px';
        node.style.transform = 'translateX(-50%)';
        // 靠近判定数据：NPC x 为水平中心 / 交互动词
        node._ix = { cx: n.x, top: n.bottom - nh, range: Math.max(60, nh * 0.25) + NEAR_PAD, name: n.tip || '', verb: n.verb || '交谈' };
        node.innerHTML = '<img src="' + n.img + '" alt="">';
        // 交互动作：仅由键盘（J / 空格）在靠近时触发
        node._act = function () {
          if (self._lock || self._ending) return;
          if (!self.isNear(node)) return;   // 必须靠近才能交互
          if (typeof n.action === 'string') self[n.action]();
          else n.action(self);
        };
        el.npcLayer.appendChild(node);
      });
    },

    /* -------------------------------------------------- 动态物件（公交车） */
    renderTimers: function () {
      var self = this;
      var sc = D.SCENES[this.state.scene];
      if (!sc || !sc.timers) return;   // 结局等无场景状态下不渲染动态物件

      sc.timers.forEach(function (cfg) {
        var show = function () {
          if (cfg.bus) self.spawnBus(cfg);
          else self.spawnProp(cfg);
        };
        // 首次较快出现，之后按 every 周期刷新（可暂停计时器）
        self.stTimeout(show, 2500);
        self.stInterval(show, cfg.every);
      });
    },

    /* 普通动态物件：出现 stay 毫秒后消失 */
    spawnProp: function (cfg) {
      var self = this;
      var node = document.createElement('div');
      node.className = 'moving-prop';
      node.style.left = cfg.prop.x + 'px';
      node.style.top = cfg.prop.y + 'px';
      node.style.width = cfg.prop.w + 'px';
      node.style.height = cfg.prop.h + 'px';
      node.textContent = cfg.prop.text;
      // 靠近判定数据：中心 x / 顶部 y / 触发半径 / 提示名 / 交互动词
      node._ix = {
        cx: cfg.prop.x + cfg.prop.w / 2, top: cfg.prop.y,
        range: cfg.prop.w / 2 + NEAR_PAD, name: cfg.prop.text || '', verb: cfg.prop.verb || '调查'
      };
      // 交互动作：仅由键盘（J / 空格）在靠近时触发
      node._act = function () {
        if (self._lock || self._ending) return;
        if (!self.isNear(node)) return;   // 必须靠近才能交互
        cfg.click(self);
      };
      el.propLayer.appendChild(node);
      if (cfg.onEnter) cfg.onEnter(self);

      var hideId = self.stTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        if (self._nearNode === node) self.resetPrompt();   // 提示对象消失时同步清空
      }, cfg.stay);
    },

    /* 公交车：由画面一侧驶入 → 到站停靠 stay 毫秒（停在站台前才可上车）→ 继续驶离。
       班次与停靠时长由 cfg.every / cfg.stay 决定（见流程图：每 15s 一班、停靠 5s），
       行驶过程用车轮滚动帧（雪碧图）表现「来往」的动画。 */
    spawnBus: function (cfg) {
      var self = this;
      var b = cfg.bus;
      var node = document.createElement('div');
      node.className = 'bus';
      node.style.width = b.w + 'px';
      node.style.height = b.h + 'px';
      node.style.top = b.y + 'px';
      node.style.left = b.from + 'px';
      node.style.backgroundImage = 'url("' + b.src + '")';
      node.style.backgroundSize = (b.w * b.frames) + 'px ' + b.h + 'px';
      node.style.backgroundPosition = '0 0';
      el.propLayer.appendChild(node);
      if (cfg.onEnter) cfg.onEnter(self);

      // 车轮滚动：横向滚动雪碧图逐帧播放；停下时冻结在当前帧
      var frame = 0, rollId = null;
      var roll = function () {
        if (rollId) return;
        rollId = self.stInterval(function () {
          frame = (frame + 1) % b.frames;
          node.style.backgroundPositionX = (-frame * b.w) + 'px';
        }, b.fps || 80);
      };
      var halt = function () { if (rollId) { self.stDrop(rollId); rollId = null; } };

      // 驶入：车轮滚动，车身从画面外滑到站台前
      roll();
      node.style.transition = 'left ' + b.inMs + 'ms linear';
      void node.offsetWidth;                       // 强制重排，保证过渡从起点开始
      node.style.left = b.stopX + 'px';

      // 到站停靠：车轮停转，登记靠近判定 → 玩家靠近后按 J/空格上车
      self.stTimeout(function () {
        halt();
        node._ix = {
          cx: b.stopX + b.w / 2, top: b.y,
          range: b.range || (b.w / 2 + NEAR_PAD), name: b.name || '', verb: b.verb || '上车'
        };
        node._act = function () {
          if (self._lock || self._ending) return;
          if (!self.isNear(node)) return;   // 必须靠近才能交互
          cfg.click(self);
        };
      }, b.inMs);

      // 驶离：撤销交互态 → 车轮再转 → 驶出画面后销毁
      self.stTimeout(function () {
        if (self._nearNode === node) self.resetPrompt();
        delete node._ix;
        node._act = null;
        roll();
        node.style.left = b.to + 'px';
        self.stTimeout(function () {
          halt();
          if (node.parentNode) node.parentNode.removeChild(node);
        }, b.outMs);
      }, b.inMs + cfg.stay);
    },

    clearTimers: function () {
      this.stClearAll();
      el.propLayer.innerHTML = '';
      this.resetPrompt();   // 动态物件全部移除，靠近提示随之清空
    },

    /* ==================== 可暂停计时器（场景演出冻结系统）====================
       用途：进入交互选择面板 / 线索笔记 / 电脑 / 手机 / 对话独白等界面时，暂停
       场景内的全部演出（公交车行进、动态物件、延时剧情事件），避免「独白还没
       读完，公交车就开走了」。恢复后从剩余时间继续，不重新计时。 */
    stTimeout: function (fn, ms) {
      var self = this;
      var id = { fn: fn, left: ms, due: nowMs() + ms, iv: false, tid: 0 };
      this._stTimers.push(id);
      if (!this._stPaused) {
        id.tid = setTimeout(function () { self.stDrop(id); fn(); }, ms);
      }
      return id;
    },

    stInterval: function (fn, ms) {
      var id = { fn: fn, every: ms, iv: true, tid: 0 };
      this._stTimers.push(id);
      if (!this._stPaused) id.tid = setInterval(function () { fn(); }, ms);
      return id;
    },

    /* 从列表移除并清掉底层原生定时器 */
    stDrop: function (id) {
      if (!id) return;
      if (id.tid) { clearTimeout(id.tid); clearInterval(id.tid); id.tid = 0; }
      var i = this._stTimers.indexOf(id);
      if (i >= 0) this._stTimers.splice(i, 1);
    },

    stClearAll: function () {
      this._stTimers.forEach(function (id) {
        clearTimeout(id.tid); clearInterval(id.tid); id.tid = 0;
      });
      this._stTimers = [];
    },

    /* 对场景层内的 CSS 动画 / 过渡（公交车位移、道具淡入等）统一执行 pause / play */
    eachSceneAnim: function (fn) {
      [el.propLayer, el.npcLayer].forEach(function (n) {
        if (!n || !n.getAnimations) return;
        n.getAnimations({ subtree: true }).forEach(fn);
      });
    },

    /* 冻结：清掉原生定时器并按剩余时间记账；同时暂停 CSS 动画 */
    stPause: function () {
      var now = nowMs();
      this._stTimers.forEach(function (id) {
        if (!id.tid) return;
        if (!id.iv) id.left = Math.max(0, id.due - now);
        clearTimeout(id.tid); clearInterval(id.tid); id.tid = 0;
      });
      this.eachSceneAnim(function (a) { a.pause(); });
    },

    /* 恢复：按剩余时间重新挂载定时器；同时恢复 CSS 动画 */
    stResume: function () {
      var self = this;
      this._stTimers.forEach(function (id) {
        if (id.tid) return;
        if (id.iv) {
          id.tid = setInterval(function () { id.fn(); }, id.every);
        } else {
          id.due = nowMs() + id.left;
          id.tid = setTimeout(function () { self.stDrop(id); id.fn(); }, id.left);
        }
      });
      this.eachSceneAnim(function (a) { a.play(); });
    },

    /* 是否应冻结场景演出：任一全屏界面 / 对话打开时 */
    scenePauseNeeded: function () {
      return this.dlgOpen() || this.panelOpen() || this.pageOpen() ||
        this.computerOpen() || !el.phone.classList.contains('hidden');
    },

    /* 每帧与各开关对齐一次：状态变化时才真正暂停 / 恢复 */
    syncScenePause: function () {
      var want = !!this.scenePauseNeeded();
      if (want === this._stPaused) return;
      this._stPaused = want;
      if (want) this.stPause(); else this.stResume();
    },

    /* ------------------------------------------------ 手机设置 → 实际生效 */
    /* 音量 / 静音作用于全部音轨；亮度作用于场景底图 */
    applyOpts: function () {
      var o = (this.state && this.state.opts) || {};
      var v = o.mute ? 0 : this.paVolume();
      [el.bgmIndoor, el.bgmOutdoor, el.bgmTitle, el.phoneMusic].forEach(function (a) { if (a) a.volume = v; });
      this.applySceneFilter();
    },

    /* 场景底图亮度：场景自带的 dark 与「手机设置 · 亮度」叠加 */
    applySceneFilter: function () {
      if (!el.sceneBg) return;
      var sc = D.SCENES[this.state.scene] || {};
      var b = (this.state.opts && this.state.opts.bright != null) ? this.state.opts.bright : 1;
      if (sc.dark) b *= 0.62;
      el.sceneBg.style.filter = b >= 0.999 ? 'none' : ('brightness(' + b.toFixed(2) + ')');
    },

    /* 手机设置里的音量（0~1，不含静音开关） */
    paVolume: function () {
      var o = (this.state && this.state.opts) || {};
      var v = (o.vol == null) ? BGM_VOLUME : o.vol;
      return Math.max(0, Math.min(1, v));
    },

    /* ------------------------------------------------------ 背景音乐 */
    /* 进入场景时切换音轨：室内用公寓配乐，室外用 sunset-drift */
    playBgm: function (scene) {
      this.stopTitleBgm();                 // 进入游戏即停标题曲
      var want = INDOOR_SCENES[scene] ? el.bgmIndoor : el.bgmOutdoor;
      [el.bgmIndoor, el.bgmOutdoor].forEach(function (a) {
        if (!a || a === want) return;
        resetAudio(a);
      });
      this._bgm = want;
      if (!want) return;
      try {
        var p = want.play();
        if (p && p.catch) p.catch(function () {});   // 自动播放被拦截时忽略
      } catch (e) { /* 环境不支持播放（如无头测试） */ }
    },

    /* 回到标题页等场合停止所有配乐 */
    stopBgm: function () {
      resetAudio(el.bgmIndoor);
      resetAudio(el.bgmOutdoor);
      this._bgm = null;
    },

    /* ------------------------------------------------ 标题页主题曲 */
    /* 开场 LOGO 与标题页循环播放；进入游戏（playBgm）时停止 */
    playTitleBgm: function () {
      var a = el.bgmTitle;
      if (!a) return;
      this._titleBgmWanted = true;
      if (!a.paused) return;               // 已在播放（含有声 / 静音待命）则无需重来
      var self = this;
      var kick = function () {
        try {
          var p = a.play();
          if (p && p.catch) p.catch(function () {
            // 浏览器自动播放策略拦截了「有声」播放：退一步先静音起播
            // （浏览器允许静音自动播放），首次交互时再取消静音。
            // 这样主题曲从网页打开那一刻就已在走，用户一有动作立刻出声，且不必从头重播。
            if (a.muted || self._audioUnlocked) return;
            a.muted = true;
            kick();
          });
        } catch (e) {}
      };
      kick();
    },

    /* 首次用户交互：解锁有声播放。若主题曲此前是静音起播，取消静音让它立即出声 */
    resumeTitleBgmSound: function () {
      this._audioUnlocked = true;
      var a = el.bgmTitle;
      if (!a || !a.muted) return;
      a.muted = false;
      if (a.paused && this._titleBgmWanted) {
        try {
          var p = a.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
    },

    stopTitleBgm: function () {
      this._titleBgmWanted = false;
      if (el.bgmTitle) el.bgmTitle.muted = false;   // 离开标题曲后复原，避免下次静音残留
      resetAudio(el.bgmTitle);
    },

    /* ------------------------------------------------------ 主角位置/动画 */
    placeHero: function () {
      var sc = D.SCENES[this.state.scene];
      var x = Math.max(sc.walk[0], Math.min(sc.walk[1], this.state.x));
      this.state.x = x;
      var s = sceneScale(this.state.scene);
      var hw = Math.round(HERO_W * s);
      var hh = Math.round(HERO_H * s);
      el.hero.style.width = hw + 'px';
      el.hero.style.height = hh + 'px';
      el.hero.style.left = (x - hw / 2) + 'px';
      el.hero.style.top = (sc.ground - hh) + 'px';
    },

    animHero: function (moving, dt) {
      if (moving) {
        this._walkT += dt * 1000;
        // while 追赶被长帧吞掉的时间；用 -= 保留余数（相位守恒，避免卡顿一次后永久慢半拍）
        while (this._walkT >= WALK_INTERVAL) {
          this._walkT -= WALK_INTERVAL;
          this._walkFrame = (this._walkFrame + 1) % WALK_FRAMES.length;
        }
        var key = 'w' + this._walkFrame;
        if (this._curSprite !== key) {
          this._curSprite = key;
          el.sprite.style.backgroundImage = 'url("' + WALK_FRAMES[this._walkFrame] + '")';
        }
      } else if (this._curSprite !== 'idle') {
        this._curSprite = 'idle';
        this._walkFrame = 0;
        this._walkT = 0;   // 帧计时一并清零：否则起步会预支掉 walk_1（实测约 18% 的起步跳帧）
        el.sprite.style.backgroundImage = 'url("' + IDLE_SPRITE + '")';
      }
      // 角色精灵为左侧朝向：面向右时水平翻转，使行走方向与面部朝向一致
      el.sprite.style.transform = (this.state.facing > 0) ? 'scaleX(-1)' : 'none';
    },

    /* ------------------------------------------------- 靠近提示（交互动词） */
    /* 清空当前靠近状态：隐藏像素字提示、移除节点 .near 光标态 */
    resetPrompt: function () {
      if (this._nearNode) this._nearNode.classList.remove('near');
      this._nearNode = null;
      this._promptKey = '';
      if (el.prompt) el.prompt.classList.add('hidden');
    },

    /* 判断主角当前位置是否在该节点的可交互范围内 */
    isNear: function (node) {
      var ix = node && node._ix;
      if (!ix) return false;
      return Math.abs(this.state.x - ix.cx) <= ix.range;
    },

    /* 切换当前靠近对象：显示/隐藏「<动词> xxx」像素字提示 */
    setNear: function (node) {
      var multi = this._nearList.length > 1;
      // 同一对象（动词与名称）且「是否存在多选项」未变时无需刷新，避免每帧写 DOM
      var key = node ? ((node._ix.verb || '') + (node._ix.name || '') + (multi ? '|m' : '')) : '';
      if (this._nearNode === node && this._promptKey === key) return;
      if (this._nearNode) this._nearNode.classList.remove('near');
      this._nearNode = node;
      this._promptKey = key;
      if (!node) { el.prompt.classList.add('hidden'); return; }
      node.classList.add('near');
      // 范围内有多个可交互点时，用 ▾ 提示按交互键可展开选择
      el.prompt.textContent = (node._ix.verb || '调查') + ' ' + (node._ix.name || '') + (multi ? ' ▾' : '');
      el.prompt.style.left = node._ix.cx + 'px';
      el.prompt.style.top = (node._ix.top - 30) + 'px';
      el.prompt.classList.remove('hidden');
    },

    /* 每帧扫描全部可交互点，收集范围内全部对象（按距离由近到远排序） */
    updateProximity: function () {
      if (!this.canMove()) { this._nearList = []; this.setNear(null); return; }
      var hx = this.state.x, cands = [];
      [el.hotspotLayer, el.npcLayer, el.propLayer].forEach(function (layer) {
        var nodes = layer.children;
        for (var i = 0; i < nodes.length; i++) {
          var ix = nodes[i]._ix;
          if (!ix || !nodes[i]._act) continue;
          var d = Math.abs(hx - ix.cx);
          if (d <= ix.range) cands.push({ node: nodes[i], d: d });
        }
      });
      cands.sort(function (a, b) { return a.d - b.d; });   // 距离相同时保持原有先后
      this._nearList = cands.map(function (c) { return c.node; });
      this.setNear(this._nearList[0] || null);
    },

    /* 键盘交互：范围内只有一个对象时直接触发；有多个时弹出选择面板 */
    interact: function () {
      if (!this._inGame || this._lock || this._ending) return false;
      var list = this._nearList;
      if (!list || !list.length) return false;
      if (list.length === 1) { list[0]._act(); this.advanceTime(TIME_PER_TALK); return true; }
      this.chooseNearby(list);
      return true;
    },

    /* 弹出「交互哪个」选择面板（同一位置有多个可交互点时） */
    chooseNearby: function (list) {
      var html = '<p class="dim">这里有几个可以交互的对象，选择要进行的操作：</p>' +
        '<div class="menu-list">';
      list.forEach(function (node, i) {
        html += '<button type="button" data-p="near" data-near="' + i + '">' +
          (node._ix.verb || '调查') + ' ' + (node._ix.name || '') + '</button>';
      });
      html += '<button type="button" data-p="cancel">取消</button></div>';
      this._nearPick = list;
      this.openPanel('选择', html);
    },

    /* 选择面板落定：关闭面板并执行对应对象的交互 */
    pickNear: function (i) {
      var list = this._nearPick || [];
      var node = list[i];
      this.closePanel();
      if (node && node._act) { node._act(); this.advanceTime(TIME_PER_TALK); }
    },

    /* ========================================================== 主循环 === */
    loop: function (ts) {
      if (!this._last) this._last = ts;
      var dt = Math.min(0.05, (ts - this._last) / 1000);
      this._last = ts;
      this.update(dt);
      this.tickDialogue(dt);
      requestAnimationFrame(this._loopBound);
    },

    update: function (dt) {
      // 静置计时：用于「深度思考」按钮在任意界面停留 10 秒后显现
      this._idleT += dt;
      this.updateThink();
      this.syncScenePause();   // 兜底：每帧对齐场景演出的暂停 / 恢复状态
      this.syncTimeEnd();      // 兜底：跨过 24:00 且界面已收起时收尾并进入下一天

      var sc = D.SCENES[this.state.scene];
      if (!sc) return;
      if (sc.map) return;   // 导览图场景：无角色行走与靠近判定

      var dir = 0;
      if (this.canMove()) {
        if (this._keys.left) dir = -1;
        else if (this._keys.right) dir = 1;
      }

      if (dir !== 0) {
        this.state.facing = dir;
        var nx = this.state.x + dir * SPEED * dt;
        if (nx < sc.walk[0] && sc.exits && sc.exits.left) { this.travel('left'); return; }
        if (nx > sc.walk[1] && sc.exits && sc.exits.right) { this.travel('right'); return; }
        this.state.x = Math.max(sc.walk[0], Math.min(sc.walk[1], nx));
        this.placeHero();
      }

      this.animHero(dir !== 0, dt);
      this.updateProximity();
    },

    canMove: function () {
      return this._inGame && !this._lock && !this._ending &&
        el.dialogue.classList.contains('hidden') &&
        el.panel.classList.contains('hidden') &&
        el.computer.classList.contains('hidden') &&
        el.phone.classList.contains('hidden');
    },

    /* ========================================================== 对话 ==== */
    say: function (lines, done) {
      // 消费线索内心独白缓冲：把它接到本次对白的末尾（先剧情、后锐评）
      if (this._pendingRemarks.length) {
        var extra = this._pendingRemarks;
        this._pendingRemarks = [];
        lines = (lines && lines.length ? lines.slice() : []).concat(extra);
      }
      if (!lines || !lines.length) { if (done) done(); return; }
      this._queue = lines.slice();
      this._dlgDone = done || null;
      // 电脑 / 手机界面之上也要能显示独白，故抬高层级（见 style.css .over-ui）
      el.dialogue.classList.toggle('over-ui', this.computerOpen() || !el.phone.classList.contains('hidden'));
      el.dialogue.classList.remove('hidden');
      el.stage.classList.add('speaking');   // 对话/独白期间屏蔽其他可交互点
      this.renderLine();
      this.syncScenePause();   // 独白期间冻结场景演出（公交车等）
    },

    renderLine: function () {
      var line = this._queue[0];
      var sp = D.SPEAKERS[line.s] || D.SPEAKERS.sys;
      el.dlgName.textContent = sp.name || '';
      el.dlgText.textContent = line.t;
      // 无头像的说话人（旁白 sys 等）：整块头像框一起收起，不留空框
      var hasFace = !!sp.avatar;
      el.dlgAvatar.style.display = hasFace ? '' : 'none';
      el.dlgAvatar.src = sp.avatar || '';
      el.dlgAvatar.alt = sp.name || '';
      el.dialogue.classList.toggle('no-face', !hasFace);
      // 「跳过已读」按钮仅在这一句读过时出现；首次展示即登记为已读
      var seen = !!this._seen[lineKey(line)];
      el.dlgSkip.classList.toggle('hidden', !seen);
      if (!seen) this.markSeen(line);

      // 立绘：只有说话人有全身立绘时才切换。主角独白 / 旁白保持当前立绘不闪断
      var pf = this._portraitMuted ? '' : (sp.portrait || '');
      if (line.s !== 'hero' && line.s !== 'sys' && pf !== this._portrait) {
        this._portrait = pf;
        if (pf) {
          el.dlgPortraitImg.src = pf;
          el.dlgPortraitImg.alt = sp.name || '';
          el.dlgPortrait.classList.remove('hidden');
          el.dlgPortrait.classList.remove('in');
          void el.dlgPortrait.offsetWidth;   // 强制重排，让切入动画重放
          el.dlgPortrait.classList.add('in');
        } else {
          el.dlgPortrait.classList.add('hidden');
        }
      }
    },

    advance: function () {
      if (this.dlgOpen()) {
        this._queue.shift();
        if (this._queue.length) { this.renderLine(); return; }
      }
      this.closeDialogue();
    },

    closeDialogue: function () {
      el.dialogue.classList.add('hidden');
      el.dialogue.classList.remove('over-ui');
      el.stage.classList.remove('speaking');   // 对话结束，恢复其他可交互点
      this._queue = [];
      this._portrait = '';                     // 对话结束，收走立绘
      el.dlgPortrait.classList.add('hidden');
      el.dlgPortrait.classList.remove('in');
      var done = this._dlgDone;
      this._dlgDone = null;
      this.renderHotspots();   // 对话后可能改变线索/flag，刷新热点可见性
      this.syncScenePause();   // 对话结束，恢复场景演出
      if (done) done();
    },

    dlgOpen: function () {
      return !el.dialogue.classList.contains('hidden');
    },

    /* ------------------------------------------- 已读记录 / 跳过已读 */
    loadSeen: function () {
      try {
        var m = JSON.parse(localStorage.getItem(K_SEEN));
        return (m && typeof m === 'object') ? m : {};
      } catch (e) { return {}; }
    },

    /* ------------------------------------------- 可自定义按键 */
    loadKeys: function () {
      var map = { interact: DEFAULT_KEYS.interact };
      try {
        var m = JSON.parse(localStorage.getItem(K_KEYS));
        if (m && typeof m === 'object' && typeof m.interact === 'string') map.interact = m.interact;
      } catch (e) {}
      return map;
    },

    saveKeys: function () {
      try { localStorage.setItem(K_KEYS, JSON.stringify(this._keyMap)); } catch (e) {}
    },

    /* 键帽显示文案：短键显示大写字母，特殊键显示符号 / 中文名 */
    keyLabel: function (k) {
      var m = {
        ' ': '空格', 'arrowleft': '←', 'arrowright': '→', 'arrowup': '↑', 'arrowdown': '↓',
        'enter': '回车', 'escape': 'Esc', 'control': 'Ctrl', 'tab': 'Tab',
        'shift': 'Shift', 'alt': 'Alt', 'backspace': '退格'
      };
      if (m[k]) return m[k];
      if (k.length === 1) return k.toUpperCase();
      return k;
    },

    /* 进入改键捕获态：下一次按键即写入配置（Esc 取消） */
    startRebind: function (name) {
      this._rebind = name;
      this.showSettings();
    },

    markSeen: function (line) {
      var k = lineKey(line);
      if (this._seen[k]) return;
      this._seen[k] = 1;
      try { localStorage.setItem(K_SEEN, JSON.stringify(this._seen)); } catch (e) {}
    },

    /* 跳过队首连续已读的行；整段都已读时直接结束对话（done 仍会触发） */
    skipSeen: function () {
      if (!this.dlgOpen()) return false;
      var skipped = false;
      while (this._queue.length && this._seen[lineKey(this._queue[0])]) {
        this._queue.shift();
        skipped = true;
      }
      if (!skipped) return false;
      if (this._queue.length) this.renderLine();
      else this.closeDialogue();
      return true;
    },

    /* 按住 Ctrl 时以 FAST_ADV 的节奏自动推进对话 */
    tickDialogue: function (dt) {
      if (!this._ctrlHeld || !this.dlgOpen()) { this._fastT = 0; return; }
      this._fastT += dt;
      if (this._fastT >= FAST_ADV) { this._fastT = 0; this.advance(); }
    },

    /* ========================================================== 面板 ==== */
    openPanel: function (title, html) {
      el.panelTitle.textContent = title;
      el.panelBody.innerHTML = html;
      el.panelBody.scrollTop = 0;
      // 结局结算面板不提供关闭按钮：关闭后无常规出口，会导致页面卡住
      if (el.panelClose) el.panelClose.classList.toggle('hidden', !!this._ending);
      el.panel.classList.remove('hidden');
      this.syncScenePause();   // 面板打开 → 冻结场景演出
    },

    closePanel: function () {
      // 结局结算面板不允许关闭（底栏已隐藏、场景为空，关掉就没有出口了）
      if (this._ending) return;
      el.panel.classList.add('hidden');
      this._nearPick = null;
      this.syncScenePause();
    },

    panelOpen: function () { return !el.panel.classList.contains('hidden'); },

    /* ------- 全屏档案页（成就 / 设置）------- */
    openPage: function (title, html) {
      el.pageTitle.textContent = title;
      el.pageBody.innerHTML = html;
      el.pageBody.scrollTop = 0;
      el.page.classList.remove('hidden');
      this.syncScenePause();
    },

    closePage: function () {
      this._rebind = null;
      el.page.classList.add('hidden');
      this.syncScenePause();
    },

    pageOpen: function () { return !el.page.classList.contains('hidden'); },

    showMenu: function () {
      this.openPanel('游戏菜单', [
        '<div class="menu-list">',
        '<button type="button" data-p="cancel">继续游戏</button>',
        '<button type="button" data-p="notes">线索笔记</button>',
        '<button type="button" data-p="achv">成就</button>',
        '<button type="button" data-p="save">保存进度</button>',
        '<button type="button" data-p="load">读取进度</button>',
        '<button type="button" data-p="settings">游戏设置</button>',
        '<button type="button" data-p="title">回到标题</button>',
        '</div>'
      ].join(''));
    },

    /* 线索笔记：未发现的以 ??? 呈现 */
    showNotes: function () {
      var self = this;
      var set = this._inGame ? this.state.clues : this.readMeta().clues;
      var html = '<p class="dim">已发现 ' + Object.keys(set).length + ' / ' +
        Object.keys(D.CLUES).length + ' 条线索。</p>';
      Object.keys(D.CLUES).forEach(function (id) {
        var c = D.CLUES[id];
        if (set[id]) {
          html += '<div class="entry"><div class="t">' + c.t + '</div>' +
            '<div class="s">' + c.s + '</div><div class="d">' + c.d + '</div></div>';
        } else {
          html += '<div class="entry" style="opacity:.42"><div class="t">？？？</div>' +
            '<div class="s">尚未发现</div></div>';
        }
      });
      // 结局结算期间用全屏档案页承载，关闭后仍回到结局面板（而非替换掉返回入口）
      if (this._ending) this.openPage('线索笔记', html);
      else this.openPanel('线索笔记', html);
    },

    /* 成就页：全屏档案式，含解锁进度条 */
    showAchievements: function () {
      var set = this._inGame ? this.state.achv : this.readMeta().achv;
      var ids = Object.keys(D.ACHIEVEMENTS);
      var got = ids.filter(function (id) { return !!set[id]; }).length;
      var pct = ids.length ? Math.round(got / ids.length * 100) : 0;
      var html = '<p class="pg-lead">已解锁 ' + got + ' / ' + ids.length + ' 项成就（' + pct + '%）</p>' +
        '<div class="pg-bar"><i style="width:' + pct + '%"></i></div><div class="achv-grid">';
      ids.forEach(function (id) {
        var a = D.ACHIEVEMENTS[id];
        var has = !!set[id];
        html += '<div class="achv-card ' + (has ? 'got' : 'locked') + '">' +
          '<img src="../art/成就.png" alt="">' +
          '<div><div class="n">' + (has ? a.t : '？？？') + '</div>' +
          '<div class="d">' + (has ? a.d : '尚未解锁') + '</div></div></div>';
      });
      html += '</div>';
      this.openPage('成就', html);
    },

    /* 「深度思考」按钮的显现条件：已达成 ≥2 次结局，且当前界面静置超过 10 秒 */
    updateThink: function () {
      if (!el.barThink) return;
      var show = this._inGame && !this._ending &&
        (this._endings || 0) >= 2 && this._idleT > 10;
      el.barThink.classList.toggle('hidden', !show);
    },

    /* 深度思考（隐藏功能）：达成 2 次结局后，在任意界面静置 10 秒才会从底栏显现。
       连续按下 10 次解锁隐藏成就 deepthinker。 */
    deepThink: function () {
      var now = Date.now();
      if (now - (this._lastThink || 0) > 3000) this._thinkCount = 0;   // 间隔过久则重新计数
      this._lastThink = now;
      this._thinkCount = (this._thinkCount || 0) + 1;

      if (this._thinkCount >= 10) {
        this._thinkCount = 0;
        this.unlock('deepthinker');
        return;
      }
      var lines = [
        [{ s: 'hero', t: '（我盯着天花板，脑子里的线索一条条浮上来。）' }],
        [{ s: 'hero', t: '（这些公司，看起来都太正常了……正常得不像真的。）' }],
        [{ s: 'hero', t: '（如果我什么都不查，就把钱交出去，会怎么样？）' }],
        [{ s: 'hero', t: '（他们说"四天后做决定"。可决定权，真的在我手上吗？）' }],
        [{ s: 'hero', t: '（再往下想，好像能摸到什么了。）' }]
      ];
      this.say(lines[(this._thinkCount - 1) % lines.length]);
    },

    /* 设置页：全屏分区式 */
    showSettings: function () {
      this.openPage('游戏设置', [
        '<div class="set-sec"><h3>操作说明</h3>',
        '<div class="set-row"><span class="k"><span class="keycap">A</span><span class="keycap">←</span> 向左移动</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">D</span><span class="keycap">→</span> 向右移动</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">空格</span><span class="keycap">回车</span> 推进对话</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">Ctrl</span>（按住）加速对话</span></div>',
        '<div class="set-row"><span class="k">对话中「跳过已读」：跳过已经看过的对话</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">F</span> 收缩 / 展开底栏</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">Esc</span> 返回上一层</span></div>',
        '</div>',
        '<div class="set-sec"><h3>按键设置</h3>',
        '<div class="set-row"><span class="k">交互（靠近后按此键执行操作，如查看 / 打开 / 上车）</span>',
        (this._rebind === 'interact'
          ? '<button type="button" class="key-btn capturing" data-pg="rebind" data-key="interact">按下新键…</button>'
          : '<button type="button" class="key-btn" data-pg="rebind" data-key="interact">' + this.keyLabel(this._keyMap.interact) + '</button>'),
        '</div>',
        '<div class="set-row"><span class="k">点击右侧键帽后按下新键即可修改；<span class="keycap">Esc</span> 取消</span></div>',
        '<div class="set-row"><span class="k"><span class="keycap">空格</span> 通用确认（固定，不可修改）</span></div>',
        '</div>',
        '<div class="set-sec"><h3>显示与声音</h3>',
        '<div class="set-row"><span class="k">音效</span><span class="v">本 DEMO 无音频</span></div>',
        '<div class="set-row"><span class="k">文字显示</span><span class="v">点击 / 按键推进</span></div>',
        '<div class="set-row"><span class="k">画面风格</span><span class="v">2D 像素风 · 960 × 720</span></div>',
        '</div>',
        '<div class="set-sec set-danger"><h3>存档管理</h3>',
        '<div class="menu-list"><button type="button" data-pg="wipe">清除全部存档与成就</button></div>',
        '</div>'
      ].join(''));
    },

    /* 存/读档面板 */
    showSlots: function (mode) {
      var self = this;
      var html = '<p class="dim">' + (mode === 'save' ? '选择一个位置保存当前进度。' : '选择一个存档读取。') + '</p><div class="menu-list">';
      for (var i = 1; i <= SLOTS; i++) html += this.slotButtonHtml(i, mode);
      html += this.slotButtonHtml('auto', mode);
      html += '<button type="button" data-p="' + (this._inGame ? 'menu' : 'cancel') + '">返回</button></div>';
      this.openPanel(mode === 'save' ? '保存进度' : '读取存档', html);
    },

    slotButtonHtml: function (n, mode) {
      var d = this.readSlot(n);
      var label = (n === 'auto' ? '自动存档' : '存档 ' + n);
      var info = d ? ('第 ' + d.state.day + ' 天 · ' + d.state.date.m + '月' + d.state.date.d + '日 · 线索 ' +
        Object.keys(d.state.clues).length + ' 条') : '（空）';
      return '<button type="button" data-p="slot" data-n="' + n + '" data-mode="' + mode + '">' +
        label + '　—　' + info + '</button>';
    },

    slotChosen: function (n, mode) {
      if (mode === 'save') {
        if (!this._inGame) return;
        this.save(n);
        this.showSlots('save');
      } else {
        this.loadSlot(n);
      }
    },

    /* ===================================================== 存档 / 读档 === */
    slotKey: function (n) { return (n === 'auto') ? K_AUTO : (K_SAVE + n); },

    readSlot: function (n) {
      try {
        var raw = localStorage.getItem(this.slotKey(n));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    save: function (n, quiet) {
      try {
        localStorage.setItem(this.slotKey(n), JSON.stringify({ state: this.state, t: Date.now() }));
      } catch (e) {
        this.toast('存档写入失败');
        return;
      }
      this.syncMeta();
      if (!quiet) this.toast(n === 'auto' ? '已自动保存' : '已保存到存档 ' + n);
    },

    autoSave: function () { this.save('auto', true); },

    loadSlot: function (n) {
      var d = this.readSlot(n);
      if (!d || !d.state) { this.toast('这个存档位是空的'); return; }
      this.state = this.normalizeState(d.state);
      this._ending = false;
      this._inGame = true;
      this._curSprite = '';
      this._walkT = 0;                    // 与 idle 分支同理：确保读档后起步也从 walk_1 开始
      el.title.classList.add('hidden');
      el.hud.classList.remove('hidden');
      el.bottombar.classList.remove('hidden');
      this.closePanel();
      this.closePage();
      this.enterScene();
      this.toast('读取成功 · 第 ' + this.state.day + ' 天');
    },

    /* 跨存档累计的线索 / 成就 / 结局次数（标题页展示、解锁深度思考） */
    readMeta: function () {
      try {
        var m = JSON.parse(localStorage.getItem(K_META));
        if (!m || !m.clues) throw 0;
        if (typeof m.endings !== 'number') m.endings = 0;
        return m;
      } catch (e) { return { clues: {}, achv: {}, endings: 0 }; }
    },

    /* 达成一次结局后累加结局次数（用于解锁「深度思考」） */
    bumpMetaEndings: function () {
      var m = this.readMeta();
      m.endings = (m.endings || 0) + 1;
      this._endings = m.endings;
      try { localStorage.setItem(K_META, JSON.stringify(m)); } catch (e) {}
    },

    syncMeta: function () {
      var m = this.readMeta();
      var s = this.state;
      Object.keys(s.clues).forEach(function (k) { m.clues[k] = 1; });
      Object.keys(s.achv).forEach(function (k) { m.achv[k] = 1; });
      try { localStorage.setItem(K_META, JSON.stringify(m)); } catch (e) {}
    },

    wipeAll: function () {
      try {
        for (var i = 1; i <= SLOTS; i++) localStorage.removeItem(K_SAVE + i);
        localStorage.removeItem(K_AUTO);
        localStorage.removeItem(K_META);
      } catch (e) {}
      this.toast('已清除全部存档');
      this.closePanel();
      if (!this._inGame) this.refreshTitle();
    },

    /* ======================================================= 标题页 ==== */
    showSplash: function (done) {
      this.playTitleBgm();                 // 开场 LOGO 起即响主题曲
      el.splash.classList.remove('hidden');
      requestAnimationFrame(function () { el.splash.classList.add('show'); });

      // LOGO 完全浮现后，台灯头才开始连闪三下，保证闪烁的过程看得清
      setTimeout(function () { el.splash.classList.add('blink'); }, 1500);

      // LOGO 展示够久之后：先让 LOGO 自己完全淡出，再让标题页缓缓浮现。
      // 两段严格先后、互不重叠，避免出现「两个画面同时隐约可见」的叠影。
      setTimeout(function () {
        el.splash.classList.remove('blink');
        el.splash.classList.remove('show');
        setTimeout(function () {
          el.splash.classList.add('hidden');
          if (done) done();
        }, 1700);
      }, 4000);
    },

    showTitle: function () {
      this._inGame = false;
      this._ending = false;
      this.stopBgm();
      this.playTitleBgm();                 // 回到标题页即恢复主题曲
      // 全面复位：从任意时刻（含结局结算）回到标题都必须是干净状态，否则会残留
      // 界面 / 锁 / 队列导致无法继续操作。顺序上先清演出与临时状态，再收各层界面。
      this.clearTimers();
      this._restPending = false;
      this._timeEnding = false;
      this._nearPick = null;
      this._queue = [];
      this._dlgDone = null;
      this._ctrlHeld = false;
      this._keys.left = this._keys.right = false;
      this.resetPrompt();
      this.closePanel();
      this.closePage();
      this.hideNet();
      el.computer.classList.add('hidden');
      el.compView.src = 'about:blank';
      this._page = '';
      el.phone.classList.add('hidden');
      el.phoneView.src = 'about:blank';
      this.phoneHome();
      el.dialogue.classList.add('hidden');
      el.stage.classList.remove('speaking');
      this._portrait = '';
      el.dlgPortrait.classList.add('hidden');
      el.dlgPortrait.classList.remove('in');
      el.hotspotLayer.innerHTML = '';
      el.npcLayer.innerHTML = '';
      el.curtain.classList.remove('on');
      el.curtain.classList.remove('cutin');
      this._lock = false;
      el.hud.classList.add('hidden');
      el.bottombar.classList.add('hidden');
      el.toast.classList.add('hidden');
      el.title.classList.remove('hidden');
      // 强制重排让 opacity:0 先生效，再加 show 触发淡入（同步，无需 rAF）
      el.title.classList.remove('show');
      void el.title.offsetWidth;
      el.title.classList.add('show');
      this.refreshTitle();
      this.syncScenePause();
    },

    refreshTitle: function () {
      var cont = el.title.querySelector('[data-act="continue"]');
      cont.style.opacity = this.readSlot('auto') ? '1' : '.45';
    },

    /* 是否存在任何游戏进度（自动存档或手动存档） */
    hasAnyProgress: function () {
      if (this.readSlot('auto')) return true;
      for (var i = 1; i <= SLOTS; i++) { if (this.readSlot(i)) return true; }
      return false;
    },

    confirmNew: function () {
      if (!this.hasAnyProgress()) { this.startNew(); return; }
      this.openPanel('开始新游戏', [
        '<p>已有游戏进度。开始新游戏将覆盖自动存档并从头开始，确定要覆盖吗？</p>',
        '<div class="menu-list">',
        '<button type="button" data-p="newgo">是，覆盖并重新开始</button>',
        '<button type="button" data-p="cancel">取消</button>',
        '</div>'
      ].join(''));
    },

    startNew: function () {
      this.state = this.newState();
      this._ending = false;
      this._inGame = true;
      this._restPending = false;
      this._timeEnding = false;
      this._webCharged = false;
      this._venuePending = false;
      this._curSprite = '';
      this._walkT = 0;                    // 与 idle 分支同理：确保开新游戏的起步也从 walk_1 开始
      el.title.classList.add('hidden');
      el.hud.classList.remove('hidden');
      el.bottombar.classList.remove('hidden');
      this.closePanel();
      this.closePage();
      this.enterScene();
      this.playPrologue();
    },

    /* 开新游戏时按幕依次播放序章，幕与幕之间插入黑幕转场，播完提示第 1 天 */
    playPrologue: function () {
      var self = this;
      var acts = D.PROLOGUE || [];
      var i = 0;
      this._portraitMuted = true;   // 序章是电话 / 回忆，全程只出头像不出立绘
      function next() {
        if (i >= acts.length) {
          self._portraitMuted = false;
          self.toast('第 1 天 · ' + D.START_DATE.m + ' 月 ' + D.START_DATE.d + ' 日（' + WEEK[self.weekday()] + '）');
          self.playTiebaBridge();   // 收尾：接续第三幕"逛论坛"的钩子，进入浏览贴吧桥段
          return;
        }
        var act = acts[i++];
        var first = (i === 1);
        var show = function () {
          if (act.title) self.toast(act.title, 1800);
          self.say(act.lines, next);
        };
        if (first) show();          // 第一幕直接开始
        else self.fade(show);       // 后续各幕：柔和黑幕转场后开演
      }
      next();
    },

    /* 序章收尾的"浏览贴吧"桥段：拿出手机自动打开贴吧列表页，供玩家自由浏览 */
    playTiebaBridge: function () {
      var self = this;
      this.setFlag('tiebaIntro', true);
      this.say([
        { s: 'sys', t: '你拿出手机，在贴吧里输入了"晶脉文旅有限公司"。' },
        { s: 'hero', t: '虽然不记得当初看到的是哪个帖子了……还是先看第一个吧。' }
      ], function () {
        self.openPhone();
        self.phoneOpenBrowser('tieba.html', true);   // 序章演出免体力，不占用当日调查次数
      });
    },

    continueGame: function () {
      if (!this.readSlot('auto')) { this.toast('还没有任何进度'); return; }
      this.loadSlot('auto');
    },

    backToTitle: function () {
      this.closePanel();
      this.showTitle();
    },

    /* ======================================================== 手机 ==== */
    openPhone: function () {
      el.phone.classList.remove('hidden');
      this.phoneHome();
      this.syncScenePause();   // 手机界面打开 → 冻结场景演出
    },

    closePhone: function () {
      this.stopPhoneMusic(true);
      el.phone.classList.add('hidden');
      el.phoneView.src = 'about:blank';   // 释放内嵌页面
      this.phoneHome();
      this.syncScenePause();   // 手机收起 → 恢复场景演出（若随后接独白会再次冻结）
      // 序章后的"浏览贴吧"收尾：第一次关掉手机时补一句过渡，衔接到电脑分支
      if (this.flag('tiebaIntro') && !this.flag('tiebaSeen')) {
        this.setFlag('tiebaSeen', true);
        this.say([
          { s: 'hero', t: '这些帖子看起来都很正常啊……' },
          { s: 'sys', t: '你关掉贴吧，决定用电脑再查一查。' }
        ]);
        return;
      }
      this.restIfExhausted();
    },

    /* 手机主屏：所有子页面收起，音乐 / 通话 / 录音计时全部复位 */
    phoneHome: function () {
      this.stopPhoneMusic(true);
      this.clearCallTimer();
      this.clearRecTimer();
      this._webClueWatch = null;   // 收起手机浏览器：丢弃待发现的线索
      this._paApp = '';
      this._paSub = '';
      el.phoneHome.classList.remove('hidden');
      el.phoneBrowser.classList.add('hidden');
      el.phoneApp.classList.add('hidden');
      el.phoneAppBody.innerHTML = '';
    },

    /* 手机浏览器：打开并载入指定网页；free=true（序章演出）不计体力 */
    phoneOpenBrowser: function (page, free) {
      this.markPhoneApp('browser');   // 浏览器也算主屏应用之一，计入「掌中世界」
      // 新的一次浏览器会话：打开浏览器本身不扣体力，调查网址时立即结算
      this._webCharged = !!free;      // 序章演出免体力，直接视为已扣费
      this._webClueWatch = null;      // 新会话：丢弃上一轮待发现的线索
      this.stopPhoneMusic(true);
      this._paApp = '';
      this._paSub = '';
      el.phoneHome.classList.add('hidden');
      el.phoneApp.classList.add('hidden');
      el.phoneBrowser.classList.remove('hidden');
      this._phoneHist = []; this._phoneIdx = -1;   // 每次打开浏览器，历史从当前页重新开始
      this._webApplied.phone = '';
      this.phoneLoad(page || 'search.html');
    },

    phoneLoad: function (page) {
      var info = D.WEB_PAGES[page];
      el.phoneUrl.textContent = info ? ('https://' + info.url) : page;
      el.phoneView.src = '../art/web/' + page;
    },

    /* iframe 载入完成 → 依据页面判定线索 / 成就（与电脑浏览器共享同一张映射表）
       http 下可直读 location；file:// 下会抛 SecurityError，由网页自报（web:page）兜底 */
    onPhoneLoad: function () {
      var path;
      try { path = el.phoneView.contentWindow.location.pathname; } catch (e) { return; }
      this.applyWebPage('phone', path.split('/').pop());
    },

    /* ------------------------------------------------ 手机 · 应用框架 ----
       主屏 11 个应用里的 10 个（浏览器除外）走同一套二级页框架：
       打开 → renderPhoneApp() 按 _paApp 分发到对应 paViewX()，返回 → phoneAppBack()。 */
    openPhoneApp: function (app) {
      if (!PHONE_APP_TITLES[app]) return;
      this._paApp = app;
      this._paSub = '';
      this._paTab = (app === 'phone') ? 'recents' : '';
      this._paDigits = '';
      this._paConv = -1;
      this._paPhoto = -1;
      this._paQq = -1;
      this.markPhoneApp(app);
      el.phoneHome.classList.add('hidden');
      el.phoneBrowser.classList.add('hidden');
      el.phoneApp.classList.remove('hidden');
      this.renderPhoneApp();
      this.syncScenePause();
    },

    /* 依次打开过每一个应用 → 收藏类成就「掌中世界」 */
    markPhoneApp: function (app) {
      if (!this.state.apps) this.state.apps = {};
      if (this.state.apps[app]) return;
      this.state.apps[app] = true;
      var got = 0;
      for (var i = 0; i < PHONE_APPS.length; i++) if (this.state.apps[PHONE_APPS[i]]) got++;
      if (got >= PHONE_APPS.length) this.unlock('phone_master');
    },

    /* 应用内「返回」：二级页 → 一级，一级 → 主屏 */
    phoneAppBack: function () {
      if (this._paApp === 'phone' && this._paSub === 'incall') { this.paHangup(); return; }
      if (this._paSub) {
        this._paSub = '';
        this._paConv = -1;
        this._paPhoto = -1;
        this._paQq = -1;
        this.renderPhoneApp();
        return;
      }
      if (this._paApp === 'phone' && this._paTab === 'dial') {
        this._paTab = 'recents';
        this._paDigits = '';
        this.renderPhoneApp();
        return;
      }
      this.phoneHome();
    },

    /* 按当前应用渲染内容区（视图函数名 = paView + 首字母大写(app)） */
    renderPhoneApp: function () {
      var app = this._paApp;
      if (!app) return;
      el.phoneAppTitle.textContent = PHONE_APP_TITLES[app] || '';
      var fn = this['paView' + app.charAt(0).toUpperCase() + app.slice(1)];
      el.phoneAppBody.innerHTML = (typeof fn === 'function') ? fn.call(this) : '';
      var vf = el.phoneAppBody.querySelector('.pa-vf');
      if (vf) vf.style.backgroundImage = 'url("' + this.sceneBgUrl() + '")';
      el.phoneAppBody.scrollTop = 0;
    },

    /* 应用内的点击分发（事件委托到 #phone-app-body） */
    onPhoneAppClick: function (ev) {
      var t = ev.target.closest('[data-pa]');
      if (!t) return;
      var act = t.getAttribute('data-pa');
      var i;
      if (act === 'tab') {
        this._paTab = t.getAttribute('data-tab');
        this._paSub = '';
        this._paDigits = '';
        this.renderPhoneApp();
      } else if (act === 'call') {
        this.paStartCall(t.getAttribute('data-name'));
      } else if (act === 'recent') {
        this.paStartCall(t.getAttribute('data-name'));
      } else if (act === 'key') {
        this.paKey(t.getAttribute('data-k'));
      } else if (act === 'dialcall') {
        this.paDialCall();
      } else if (act === 'hangup') {
        this.paHangup();
      } else if (act === 'conv') {
        i = parseInt(t.getAttribute('data-i'), 10);
        if (i >= 0) { this._paConv = i; this._paSub = 'thread'; this.renderPhoneApp(); }
      } else if (act === 'qqpost') {
        i = parseInt(t.getAttribute('data-i'), 10);
        if (i >= 0) { this._paQq = i; this._paSub = 'post'; this.renderPhoneApp(); }
      } else if (act === 'photo') {
        i = parseInt(t.getAttribute('data-i'), 10);
        if (i >= 0) { this._paPhoto = i; this._paSub = 'view'; this.renderPhoneApp(); }
      } else if (act === 'back') {
        this.phoneAppBack();
      } else if (act === 'clip') {
        this.toast('本 DEMO 不播放录音');
      } else if (act === 'rec') {
        this.paToggleRec();
      } else if (act === 'song') {
        i = parseInt(t.getAttribute('data-i'), 10);
        if (i >= 0) { this._paIdx = i; this._paSub = 'player'; this.paPlay(); this.renderPhoneApp(); }
      } else if (act === 'play') {
        this.paTogglePlay();
      } else if (act === 'prev') {
        this.paPrev();
      } else if (act === 'next') {
        this.paNext();
      } else if (act === 'seek') {
        this.paSeek(ev, t);
      } else if (act === 'shoot') {
        this.paShoot();
      } else if (act === 'mute') {
        this.state.opts.mute = !this.state.opts.mute;
        this.applyOpts();
        this.renderPhoneApp();
      } else if (act === 'airplane') {
        this.state.opts.airplane = !this.state.opts.airplane;
        this.toast(this.state.opts.airplane ? '已开启飞行模式' : '已关闭飞行模式');
        this.renderPhoneApp();
      }
    },

    /* 应用内的滑块（音量 / 亮度） */
    onPhoneAppInput: function (ev) {
      var t = ev.target;
      var key = t.getAttribute ? t.getAttribute('data-pa') : '';
      var v = parseInt(t.value, 10);
      if (isNaN(v)) return;
      var valEl = t.parentNode.querySelector('.pa-set-val');
      if (key === 'vol') {
        this.state.opts.vol = v / 100;
        this.applyOpts();
        if (valEl) valEl.textContent = v + '%';
      } else if (key === 'bright') {
        this.state.opts.bright = v / 100;
        this.applySceneFilter();
        if (valEl) valEl.textContent = v + '%';
      }
    },

    /* ------------------------------------------------ 手机 · 规格化小组件 */
    /* 当前场景底图地址（相机取景 / 成片都用它，保证与画面一致） */
    sceneBgUrl: function () {
      var sc = D.SCENES[this.state.scene] || {};
      var bg = (typeof sc.bg === 'function') ? sc.bg(this) : sc.bg;
      return bg || '';
    },

    /* 相册照片流：现场拍的在前，预置素材在后 */
    phonePhotos: function () {
      return (this.state.shots || []).concat(D.PHONE.gallery);
    },

    /* 顶部小标签按钮 */
    paTabBtn: function (id, label) {
      var on = (this._paTab === id) ? ' active' : '';
      return '<button type="button" class="pa-tab' + on + '" data-pa="tab" data-tab="' + id + '">' + label + '</button>';
    },

    /* ------------------------------------------------ 电话 App */
    paViewPhone: function () {
      if (this._paSub === 'incall') return this.paInCallView();
      var tab = this._paTab || 'recents';
      var body = (tab === 'contacts') ? this.paContactList()
               : (tab === 'dial') ? this.paDialView()
               : this.paRecentList();
      return '<div class="pa-tabs">' +
        this.paTabBtn('recents', '通话记录') +
        this.paTabBtn('contacts', '通讯录') +
        this.paTabBtn('dial', '拨号') +
        '</div>' + body;
    },

    paRecentList: function () {
      var list = D.PHONE.recents;
      if (!list.length) return '<div class="pa-empty">暂无通话记录</div>';
      return list.map(function (r) {
        return '<div class="pa-row" data-pa="recent" data-name="' + esc(r.n) + '">' +
          '<span class="pa-av gray">' + esc(r.n.slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(r.n) + '</span>' +
          '<span class="pa-sub">' + esc(r.w) + ' · ' + esc(r.t) + '</span></span>' +
          '<span class="pa-time">' + esc(r.d) + '</span></div>';
      }).join('');
    },

    paContactList: function () {
      return D.PHONE.contacts.map(function (c) {
        return '<div class="pa-row" data-pa="call" data-name="' + esc(c.n) + '">' +
          '<span class="pa-av ' + esc(c.g) + '">' + esc(c.n.slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(c.n) + '</span>' +
          '<span class="pa-sub">' + esc(c.t) + '</span></span></div>';
      }).join('');
    },

    paDialView: function () {
      var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
      var pad = keys.map(function (k) {
        return '<button type="button" class="pa-key" data-pa="key" data-k="' + k + '">' + k + '</button>';
      }).join('');
      var num = this._paDigits || '';
      return '<div class="pa-dial">' +
        '<div class="pa-dial-num" data-pa="digits">' + (num ? esc(num) : '<span style="opacity:.45">请输入号码</span>') + '</div>' +
        '<div class="pa-keys">' + pad + '</div>' +
        '<button type="button" class="pa-call-btn" data-pa="dialcall">拨号</button>' +
        '</div>';
    },

    paInCallView: function () {
      return '<div class="pa-incall">' +
        '<div class="pa-incare"><img src="../art/来电.png" alt="通话中"></div>' +
        '<div class="who">' + esc(this._paCallWho || '未知号码') + '</div>' +
        '<div class="st" data-pa="callsec">' + mmss(this._paCallSec) + '</div>' +
        '<button type="button" class="pa-hang" data-pa="hangup">挂断</button>' +
        '</div>';
    },

    paKey: function (k) {
      if (this._paDigits.length >= 16) return;
      this._paDigits += k;
      var d = el.phoneAppBody.querySelector('[data-pa="digits"]');
      if (d) d.textContent = this._paDigits;
    },

    paDialCall: function () {
      if (!this._paDigits) { this.toast('请先输入号码'); return; }
      var digits = this._paDigits.replace(/\D/g, '');
      var hit = null;
      D.PHONE.contacts.forEach(function (c) {
        if (c.t.replace(/\D/g, '') === digits) hit = c.n;
      });
      this.paStartCall(hit || this._paDigits);
    },

    paStartCall: function (who) {
      var self = this;
      this._paCallWho = who || '未知号码';
      this._paCallSec = 0;
      this._paSub = 'incall';
      this.renderPhoneApp();
      clearInterval(this._paCallTimer);
      this._paCallTimer = setInterval(function () {
        self._paCallSec++;
        var e = el.phoneAppBody.querySelector('[data-pa="callsec"]');
        if (e) e.textContent = mmss(self._paCallSec);
      }, 1000);
    },

    paHangup: function () {
      this.clearCallTimer();
      this._paSub = '';
      this._paDigits = '';
      if (this._paApp === 'phone') this._paTab = 'recents';
      this.renderPhoneApp();
    },

    clearCallTimer: function () {
      clearInterval(this._paCallTimer);
      this._paCallTimer = null;
    },

    /* ------------------------------------------------ 短信 / 微信 */
    paViewSms: function () {
      if (this._paSub === 'thread') return this.paThreadView(D.PHONE.sms[this._paConv]);
      return this.paThreadList(D.PHONE.sms);
    },

    paViewWechat: function () {
      if (this._paSub === 'thread') return this.paThreadView(D.PHONE.wechat[this._paConv]);
      return this.paThreadList(D.PHONE.wechat);
    },

    paThreadList: function (list) {
      return list.map(function (c, i) {
        return '<div class="pa-row" data-pa="conv" data-i="' + i + '">' +
          '<span class="pa-av ' + esc(c.g) + '">' + esc(c.n.slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(c.n) + '</span>' +
          '<span class="pa-sub">' + esc(c.last) + '</span></span>' +
          '<span class="pa-time">' + esc(c.d) + '</span></div>';
      }).join('');
    },

    paThreadView: function (c) {
      if (!c) return '<div class="pa-empty">会话不存在</div>';
      var msgs = c.msgs.map(function (m) {
        var who = m.who ? '<span class="who">' + esc(m.who) + '</span>' : '';
        return '<div class="pa-msg' + (m.me ? ' me' : '') + '">' + who + esc(m.t) + '</div>';
      }).join('');
      return '<div class="pa-thread">' + msgs + '</div>';
    },

    /* ------------------------------------------------ QQ空间 */
    paViewQq: function () {
      if (this._paSub === 'post' && this._paQq >= 0 && D.PHONE.qq[this._paQq]) {
        return this.paQqView(D.PHONE.qq[this._paQq]);
      }
      return D.PHONE.qq.map(function (q, i) {
        return '<div class="pa-row" style="align-items:flex-start" data-pa="qqpost" data-i="' + i + '">' +
          '<span class="pa-av ' + esc(q.g) + '">' + esc(q.n.slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(q.n) + '</span>' +
          '<span class="pa-sub" style="white-space:normal">' + esc(q.t) + '</span>' +
          '<span class="pa-sub">' + esc(q.d) + ' · 评论 ' + q.cmt + '</span></span></div>';
      }).join('');
    },

    /* 单条动态详情：正文 + 评论列表 */
    paQqView: function (q) {
      var cmts = (q.msgs || []).map(function (c) {
        return '<div class="pa-row" style="align-items:flex-start">' +
          '<span class="pa-av ' + esc(c.g || 'gray') + '">' + esc((c.n || '').slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(c.n) + '</span>' +
          '<span class="pa-sub" style="white-space:normal">' + esc(c.t) + '</span></span></div>';
      }).join('');
      return '<div class="pa-post">' +
          '<div class="pa-post-head"><span class="pa-av ' + esc(q.g) + '">' + esc(q.n.slice(0, 1)) + '</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(q.n) + '</span>' +
          '<span class="pa-sub">' + esc(q.d) + '</span></span></div>' +
          '<div class="pa-post-body">' + esc(q.t) + '</div>' +
        '</div>' +
        '<div class="pa-sec">评论 ' + q.cmt + '</div>' +
        (cmts || '<div class="pa-empty">还没有评论</div>');
    },

    /* ------------------------------------------------ 相册 */
    paViewGallery: function () {
      var photos = this.phonePhotos();
      if (this._paSub === 'view' && this._paPhoto >= 0 && photos[this._paPhoto]) {
        return this.paPhotoView(photos[this._paPhoto]);
      }
      if (!photos.length) return '<div class="pa-empty">相册还是空的</div>';
      var grid = photos.map(function (p, i) {
        return '<button type="button" class="pa-photo" data-pa="photo" data-i="' + i + '">' +
          '<img src="' + esc(p.img) + '" alt=""></button>';
      }).join('');
      return '<div class="pa-grid">' + grid + '</div>';
    },

    paPhotoView: function (p) {
      return '<div class="pa-viewer"><img src="' + esc(p.img) + '" alt="">' +
        '<div class="cap">' + esc(p.c || '') + '</div>' +
        '<div style="padding:0 10px 12px"><button type="button" class="pa-btn" data-pa="back">返回相册</button></div>' +
        '</div>';
    },

    /* ------------------------------------------------ 录音机 */
    paViewRecorder: function () {
      var rec = !!this._paRecTimer;
      var wave = '';
      for (var i = 0; i < 20; i++) wave += '<span></span>';
      var clips = (this.state.clips || []).concat(D.PHONE.clips);
      var list = clips.map(function (c, i) {
        return '<div class="pa-row" data-pa="clip" data-i="' + i + '">' +
          '<span class="pa-av gray">♪</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(c.n) + '</span>' +
          '<span class="pa-sub">点击播放（本 DEMO 略）</span></span>' +
          '<span class="pa-time">' + esc(c.t) + '</span></div>';
      }).join('');
      return '<div class="pa-rec">' +
        '<div class="pa-wave' + (rec ? ' rec' : '') + '">' + wave + '</div>' +
        '<div style="font-family:var(--px-mono);color:var(--px-text-2)" data-pa="recsec">' + mmss(this._paRecSec) + '</div>' +
        '<button type="button" class="pa-rec-btn' + (rec ? ' stop' : '') + '" data-pa="rec">' +
          (rec ? '停止录音' : '开始录音') + '</button>' +
        '</div>' +
        (list || '<div class="pa-empty">还没有录音</div>');
    },

    paToggleRec: function () {
      var self = this;
      if (this._paRecTimer) {   // 停止
        this.clearRecTimer();
        var n = '现场备忘 · ' + (this.state.date.m + ' 月 ' + this.state.date.d + ' 日');
        this.state.clips.unshift({ n: n, t: mmss(this._paRecSec) });
        this._paRecSec = 0;
        this.renderPhoneApp();
        this.toast('已保存一段录音');
        return;
      }
      this._paRecSec = 0;
      this.renderPhoneApp();
      this._paRecTimer = setInterval(function () {
        self._paRecSec++;
        var e = el.phoneAppBody.querySelector('[data-pa="recsec"]');
        if (e) e.textContent = mmss(self._paRecSec);
      }, 1000);
    },

    clearRecTimer: function () {
      clearInterval(this._paRecTimer);
      this._paRecTimer = null;
    },

    /* ------------------------------------------------ 音乐 */
    paViewMusic: function () {
      if (this._paSub === 'player' && this._paIdx >= 0) return this.paPlayerView();
      var idx = this._paIdx;
      var rows = D.PHONE.music.map(function (m, i) {
        return '<div class="pa-row' + (i === idx ? ' playing' : '') + '" data-pa="song" data-i="' + i + '">' +
          '<span class="pa-av blue">♫</span>' +
          '<span class="pa-main"><span class="pa-name">' + esc(m.n) + '</span>' +
          '<span class="pa-sub">' + esc(m.a) + '</span></span>' +
          '<span class="pa-time">' + esc(m.t) + '</span></div>';
      }).join('');
      return rows;
    },

    paPlayerView: function () {
      var m = D.PHONE.music[this._paIdx];
      if (!m) return '<div class="pa-empty">曲目不存在</div>';
      var cover = PHONE_COVERS[this._paIdx % PHONE_COVERS.length];
      var a = el.phoneMusic;
      var pct = 0, cur = 0, dur = 0;
      if (a) {
        dur = a.duration || 0;
        cur = a.currentTime || 0;
        pct = dur ? (cur / dur * 100) : 0;
      }
      return '<div class="pa-player">' +
        '<div class="pa-cover"><img src="' + esc(cover) + '" alt=""></div>' +
        '<div class="pa-song"><div class="n">' + esc(m.n) + '</div><div class="a">' + esc(m.a) + '</div></div>' +
        '<div class="pa-bar" data-pa="seek"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="pa-times"><span data-pa="cur">' + mmss(cur) + '</span><span>' + esc(m.t) + '</span></div>' +
        '<div class="pa-ctrl">' +
          '<button type="button" data-pa="prev">上一首</button>' +
          '<button type="button" data-pa="play">' + (this._paPlaying ? '暂停' : '播放') + '</button>' +
          '<button type="button" data-pa="next">下一首</button>' +
        '</div></div>';
    },

    paPlay: function () {
      var m = D.PHONE.music[this._paIdx];
      var a = el.phoneMusic;
      if (!m || !a) return;
      if (this._bgm && !this._bgm.paused) { try { this._bgm.pause(); } catch (e) {} this._bgmDucked = true; }
      if (a.getAttribute('data-src') !== m.src) { a.src = m.src; a.setAttribute('data-src', m.src); }
      a.volume = this.state.opts.mute ? 0 : this.paVolume();
      try { var p = a.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      this._paPlaying = true;
      this.paStartTick();
    },

    paPause: function () {
      var a = el.phoneMusic;
      if (a) { try { a.pause(); } catch (e) {} }
      this._paPlaying = false;
      clearInterval(this._paTimer);
      this._paTimer = null;
      this.paRestoreBgm();
    },

    /* 音乐停止后把场景配乐接回来 */
    paRestoreBgm: function () {
      if (!this._bgmDucked) return;
      this._bgmDucked = false;
      this.playBgm(this.state.scene);
    },

    paTogglePlay: function () {
      if (this._paPlaying) this.paPause(); else this.paPlay();
      this.renderPhoneApp();
    },

    paPrev: function () {
      var n = D.PHONE.music.length;
      this._paIdx = (this._paIdx - 1 + n) % n;
      this.paPlay();
      this.renderPhoneApp();
    },

    paNext: function () {
      var n = D.PHONE.music.length;
      this._paIdx = (this._paIdx + 1) % n;
      this.paPlay();
      this.renderPhoneApp();
    },

    paStartTick: function () {
      var self = this;
      clearInterval(this._paTimer);
      this._paTimer = setInterval(function () { self.paSyncProgress(); }, 500);
      this.paSyncProgress();
    },

    paSyncProgress: function () {
      var a = el.phoneMusic;
      if (!a) return;
      var dur = a.duration || 0;
      var bar = el.phoneAppBody.querySelector('.pa-bar > i');
      var cur = el.phoneAppBody.querySelector('[data-pa="cur"]');
      if (bar && dur) bar.style.width = (a.currentTime / dur * 100).toFixed(1) + '%';
      if (cur) cur.textContent = mmss(a.currentTime);
      if (a.ended) { this._paPlaying = false; this.paNext(); }
    },

    paSeek: function (ev, bar) {
      var a = el.phoneMusic;
      if (!a || !a.duration) return;
      var r = bar.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      try { a.currentTime = pct * a.duration; } catch (e) {}
      this.paSyncProgress();
    },

    /* 收起手机 / 离开音乐时统一停播（force=true 时不做恢复） */
    stopPhoneMusic: function (force) {
      var a = el.phoneMusic;
      if (a) { try { a.pause(); } catch (e) {} }
      this._paPlaying = false;
      clearInterval(this._paTimer);
      this._paTimer = null;
      if (force) this._bgmDucked = false;
      else this.paRestoreBgm();
    },

    /* ------------------------------------------------ 时钟（跟随游戏内虚拟时间） */
    paViewClock: function () {
      var d = this.state.date;
      var zones = D.PHONE.zones.map(function (z) {
        return '<div class="pa-zone"><span class="c">' + esc(z.c) + '</span>' +
          '<span class="h">' + clockHM(this.state.minutes + z.o * 60) + '</span></div>';
      }, this).join('');
      return '<div class="pa-clock">' +
        '<div class="big" data-pa="clock-big">' + clockHM(this.state.minutes) + '</div>' +
        '<div class="dateline">' + d.y + ' 年 ' + d.m + ' 月 ' + d.d + ' 日</div>' +
        '</div>' + zones +
        '<div class="pa-about">时间与游戏内进度同步推进。</div>';
    },

    /* 游戏内时间推进 / 日切 → 手机时钟跟着走（由 advanceTime 调用） */
    syncPhoneClock: function () {
      if (this._paApp !== 'clock') return;
      var big = el.phoneAppBody.querySelector('[data-pa="clock-big"]');
      if (big) big.textContent = clockHM(this.state.minutes);
      var hs = el.phoneAppBody.querySelectorAll('.pa-zone .h');
      for (var i = 0; i < hs.length && i < D.PHONE.zones.length; i++) {
        hs[i].textContent = clockHM(this.state.minutes + D.PHONE.zones[i].o * 60);
      }
    },

    /* ------------------------------------------------ 相机 */
    paViewCamera: function () {
      return '<div class="pa-vf">' +
        '<div class="vf-frame"></div>' +
        '<div class="vf-hint">对准眼前的景物，按下快门</div>' +
        '<button type="button" class="pa-shutter" data-pa="shoot" title="拍照"></button>' +
        '<div class="pa-flash" data-pa="flash"></div>' +
        '</div>';
    },

    paShoot: function () {
      var sc = D.SCENES[this.state.scene] || {};
      var img = this.sceneBgUrl();
      if (!img) { this.toast('这里没什么好拍的'); return; }
      if (!this.state.shots) this.state.shots = [];
      this.state.shots.unshift({ img: img, c: (sc.name || '随手拍') + ' · 手机' });
      var flash = el.phoneAppBody.querySelector('[data-pa="flash"]');
      if (flash) {
        flash.classList.remove('on');
        void flash.offsetWidth;
        flash.classList.add('on');
      }
      this.toast('照片已存入相册');
    },

    /* ------------------------------------------------ 设置 */
    paViewSettings: function () {
      var o = this.state.opts || {};
      var vol = Math.round((o.vol == null ? BGM_VOLUME : o.vol) * 100);
      var bri = Math.round((o.bright == null ? 1 : o.bright) * 100);
      if (bri < 55) bri = 55;
      return '<div class="pa-set-row"><span class="lab">音量</span>' +
          '<input type="range" class="px-range" min="0" max="100" value="' + vol + '" data-pa="vol">' +
          '<span class="pa-set-val">' + vol + '%</span></div>' +
        '<div class="pa-set-row"><span class="lab">亮度</span>' +
          '<input type="range" class="px-range" min="55" max="100" value="' + bri + '" data-pa="bright">' +
          '<span class="pa-set-val">' + bri + '%</span></div>' +
        '<div class="pa-set-row"><span class="lab">静音</span>' +
          '<span style="flex:1"></span>' +
          '<span class="pa-switch' + (o.mute ? ' on' : '') + '" data-pa="mute"><i></i></span></div>' +
        '<div class="pa-set-row"><span class="lab">飞行模式</span>' +
          '<span style="flex:1"></span>' +
          '<span class="pa-switch' + (o.airplane ? ' on' : '') + '" data-pa="airplane"><i></i></span></div>' +
        '<div class="pa-about">佟家岭调查机<br>系统版本 漭江 OS 3.2<br>本机号码 138 0013 2201</div>';
    },

    /* ======================================================= 电脑 ==== */
    openComputer: function (page) {
      // 新的一次浏览器会话：打开电脑本身不扣体力，调查网址时立即结算
      this._webCharged = false;
      this._webClueWatch = null;      // 新会话：丢弃上一轮待发现的线索
      el.computer.classList.remove('hidden');
      this.hideNet();
      this._compHist = []; this._compIdx = -1;   // 每次打开浏览器，历史从当前页重新开始
      this._webApplied.comp = '';
      this.loadPage(page);
      this.syncScenePause();   // 电脑界面打开 → 冻结场景演出
    },

    loadPage: function (page) {
      var info = D.WEB_PAGES[page];
      this._page = page;
      el.compUrl.textContent = info ? ('https://' + info.url) : page;
      el.compView.src = '../art/web/' + page;
    },

    computerOpen: function () { return !el.computer.classList.contains('hidden'); },

    closeComputer: function () {
      el.computer.classList.add('hidden');
      this.hideNet();
      el.compView.src = 'about:blank';
      this._webClueWatch = null;   // 关闭浏览器：丢弃待发现的线索
      this._page = '';
      this._dev = null;
      this.renderHotspots();
      this.syncScenePause();   // 电脑关闭 → 恢复场景演出
      this.restIfExhausted();
    },

    hideNet: function () {
      el.compNet.classList.add('hidden');
      el.compNet.innerHTML = '';
    },

    /* iframe 载入完成 → 依据页面判定线索 / 成就（http 下可直读 location；file:// 下由 web:page 兜底） */
    onComputerLoad: function () {
      var path;
      try { path = el.compView.contentWindow.location.pathname; } catch (e) { return; }
      this.applyWebPage('comp', path.split('/').pop());
    },

    /* 依据网页文件名统一处理：地址栏 / 浏览历史 / 线索 / 成就 / 贴吧提示 / 官网 F12 面板。
       which: 'comp' | 'phone'；base: 网页文件名（如 index.html）。
       同一页面只处理一次——iframe load 事件与网页自报（web:page）两条路径需去重。 */
    applyWebPage: function (which, base) {
      var info = D.WEB_PAGES[base];
      if (!info) return;
      var applied = this._webApplied[which];
      if (applied === base) return;
      this._webApplied[which] = base;
      // 从其他页面跳转过来（首次打开浏览器不计）→ 推进游戏内时间
      if (applied) this.advanceTime(TIME_PER_WEB);

      var isComp = which === 'comp';
      if (isComp) this._page = base;
      var urlEl = isComp ? el.compUrl : el.phoneUrl;
      urlEl.textContent = 'https://' + info.url;
      this.recordHistory(which, base);
      this._noteWebInvestigation(base);   // 体力：调查网址计入会话，回到起始页时结算

      // 线索改为「玩家自行滚动翻找」：不自动定位；网页内线索元素进入视口中心带后才上报并发放
      this._webClueWatch = null;
      if (info.clue && !this.hasClue(info.clue)) {
        this.watchWebClue(which, base, info.focus, info.clue, info.achv);
      } else if (info.achv) {
        this.unlock(info.achv);
      }
      if (info.note) this.toast('贴吧提示 · ' + info.note, 3600);

      if (isComp) {
        // 官网：预留 F12「开发者工具 · 网络」面板；其余页面不显示
        this._dev = info.dev ? info : null;
        this.hideNet();
      }
    },

    /* 体力：一次浏览器会话里「调查一个网址」立即消耗 1 点，起始页（search.html）只是浏览器的家，
       不计为一次调查；一次会话最多扣 1 点（_webCharged），后续翻页不再累计。 */
    _noteWebInvestigation: function (base) {
      if (base === 'search.html') return;   // 起始页不计为一次调查
      if (this._webCharged) return;         // 本次会话已扣过，后续翻页不再累计
      this._webCharged = true;
      this.spendStamina(1);
      this.restIfExhausted();
    },

    /* ------------------------------------------------ 浏览器回退（电脑/手机共用） */
    /* 记录浏览历史：进入新页面时压栈；重复载入当前页（如回退、刷新）不重复记录 */
    recordHistory: function (which, page) {
      var h = which === 'comp' ? this._compHist : this._phoneHist;
      var idx = which === 'comp' ? this._compIdx : this._phoneIdx;
      if (h[idx] !== page) {
        h = h.slice(0, idx + 1);   // 从当前页向后浏览时，丢弃原有的前进记录
        h.push(page);
        if (which === 'comp') { this._compHist = h; this._compIdx = h.length - 1; }
        else { this._phoneHist = h; this._phoneIdx = h.length - 1; }
      }
      this.syncBackButtons();
    },

    /* 回退到上一页（已在第一页时不做任何事，按钮本身也会置灰） */
    browserBack: function (which) {
      var isComp = which === 'comp';
      var h = isComp ? this._compHist : this._phoneHist;
      var idx = isComp ? this._compIdx : this._phoneIdx;
      if (idx <= 0) return;
      var page = h[idx - 1];
      if (isComp) { this._compIdx = idx - 1; this._compPage(page, el.compUrl, el.compView); }
      else { this._phoneIdx = idx - 1; this._compPage(page, el.phoneUrl, el.phoneView); }
      this.syncBackButtons();
    },

    /* 把某个已记录的历史页重新载入指定浏览器的地址栏 / iframe */
    _compPage: function (page, urlEl, viewEl) {
      var info = D.WEB_PAGES[page];
      urlEl.textContent = info ? ('https://' + info.url) : page;
      viewEl.src = '../art/web/' + page;
    },

    /* 依据历史指针位置，同步两个「回退」按钮的可用状态 */
    syncBackButtons: function () {
      if (el.compBack) el.compBack.disabled = !(this._compIdx > 0);
      if (el.phoneBackPage) el.phoneBackPage.disabled = !(this._phoneIdx > 0);
    },

    /* ============================================ 开发者工具 · 网络（F12）==== */
    /* 官网界面按 F12 唤出；先看请求列表，点击第一个请求才展开响应预览，
       响应源码末尾的注释里藏着内网地址 134.200.15.42 */
    toggleDevtools: function () {
      if (!this.computerOpen() || !this._dev) return;
      if (el.compNet.classList.contains('hidden')) this.showNetList();
      else this.hideNet();
    },

    showNetList: function () {
      var info = this._dev;
      if (!info) return;
      el.compNet.innerHTML =
        '<div class="net-head">开发者工具 · 网络</div>' +
        '<div class="net-tip">此页面发出的请求（点击查看详情）</div>' +
        '<div class="net-req" data-req="1">' +
          '<span class="net-idx">1</span>' +
          '<span class="net-name">' + info.url + '/</span>' +
          '<span class="net-code">200 OK</span>' +
        '</div>' +
        '<div class="net-hint">&gt; 点击第一个请求，在预览里查看响应内容。</div>';
      el.compNet.classList.remove('hidden');
    },

    showNetPreview: function () {
      var info = this._dev;
      if (!info) return;
      el.compNet.innerHTML =
        '<div class="net-head">开发者工具 · 网络 / 响应预览</div>' +
        '<div class="net-req active" data-req="1">' +
          '<span class="net-idx">1</span>' +
          '<span class="net-name">' + info.url + '/</span>' +
          '<span class="net-code">200 OK</span>' +
        '</div>' +
        '<div class="net-preview">' +
          '<div class="cmt">&lt;!-- build: jm-site-v2.3.1 / 2024-01-12 --&gt;</div>' +
          '<div class="cmt">&lt;!-- cdn-origin: https://cdn.jingmai.com.cn/assets --&gt;</div>' +
          '<div class="cmt">&lt;!-- api-gateway: /api/v2/site/config --&gt;</div>' +
          '<div class="cmt">&lt;!-- internal-node: <a href="#" data-page="shenmai.html">134.200.15.42</a> --&gt;</div>' +
          '<div>&gt; 响应源码末尾有一段被注释掉的地址，正常渲染不会显示。</div>' +
        '</div>';
      el.compNet.classList.remove('hidden');
      this.addClue('web_index_ip');
      this.flushRemarks();
    },

    /* ============================================== 剧情专用交互方法 ==== */
    /* 居民区「随机采访居民」：场景中心交互点触发。
       交谈次数决定阶段：①正面评价 → ②大妈的女儿 → ③便衣暗访 → ④年轻人的警告
       四阶段走完后，每次交谈从随机路人池里抽一条（闲聊 / 线索 / 体力 / 离谱） */
    interviewResident: function () {
      var self = this;
      var n = (this.flag('residentTalks') || 0) + 1;
      this.setFlag('residentTalks', n);
      this.cutIn(function () { self.playResident(n); });
    },

    /* 演一场采访：主角退场 → 场景中心刷出说话人的立绘 → 播话 → 收场把主角放回来 */
    playResident: function (n) {
      var self = this;
      var script = this.residentScript(n);
      var lines = (script && script.lines) || [];
      var who = this.firstSpeaker(lines);
      var sp = who ? D.SPEAKERS[who] : null;

      el.hero.classList.add('hidden');                          // 隐藏可控角色
      var fig = this.showResidentFigure(sp ? (sp.portrait || sp.avatar || '') : '');
      this._portraitMuted = true;                               // 场景里已有立绘，不再往对话框左下压一张

      this.say(lines, function () {
        self.clearResidentFigure(fig);
        self._portraitMuted = false;
        el.hero.classList.remove('hidden');                     // 交谈结束，可控角色回到原位
        if (script && script.after) script.after();
      });
    },

    /* 取对白里第一个「真人」说话人（跳过主角独白与旁白） */
    firstSpeaker: function (lines) {
      for (var i = 0; i < lines.length; i++) {
        var s = lines[i] && lines[i].s;
        if (s && s !== 'hero' && s !== 'sys') return s;
      }
      return null;
    },

    /* 在场景中心摆出受访居民的立绘（随场景缩放），返回节点以便收场移除 */
    showResidentFigure: function (img) {
      var sc = D.SCENES[this.state.scene];
      var s = sceneScale(this.state.scene);
      var nh = Math.round(RESIDENT_FIG_H * s);
      var node = document.createElement('div');
      node.className = 'npc';
      node.style.left = (STAGE_W / 2) + 'px';
      node.style.top = ((sc && sc.ground ? sc.ground : 690) - nh) + 'px';
      node.style.height = nh + 'px';
      node.style.transform = 'translateX(-50%)';
      node.innerHTML = '<img src="' + img + '" alt="">';
      el.npcLayer.appendChild(node);
      return node;
    },

    clearResidentFigure: function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    },

    /* 按交谈次数取这一轮要说的话（返回 { lines, after }，不含演出） */
    residentScript: function (n) {
      var T = D.RESIDENT_STAGES;

      // 阶段一：居民区对景区普遍是正面评价（按流程图，此阶段不给线索）
      if (n < 2) return { lines: T.s1, after: null };

      // 阶段二：大妈讲起在晶脉上班、再没回家的女儿 → 线索 +1
      if (!this.hasClue('field_daughter')) {
        this.addClue('field_daughter');
        return { lines: T.s2, after: null };
      }

      // 阶段三：小卖部老板透露便衣警察曾来暗访 → 线索 +1
      if (!this.hasClue('field_police')) {
        this.addClue('field_police');
        return { lines: T.s3, after: null };
      }

      // 阶段四：低概率刷出一个年轻人，压低声音警告你别再查下去 → 隐藏成就 + 线索
      if (!this.unlocked('warning') && Math.random() < 0.35) {
        if (!this.hasClue('field_warning')) this.addClue('field_warning');
        this.unlock('warning');
        return { lines: T.s4, after: null };
      }

      // 四阶段都走完后：随机路人
      return this.passerbyScript();
    },

    /* 随机路人：离谱 6% / 体力 18% / 线索 26% / 闲聊 50%（对应池为空时自动回落） */
    passerbyScript: function () {
      var self = this;
      var T = D.RESIDENT_TALK;
      var r = Math.random();

      // 离谱：隐藏成就「这还是国内吗？」
      if (r < 0.06 && T.absurd && T.absurd.length) {
        if (!this.unlocked('not_domestic')) this.unlock('not_domestic');
        return { lines: this.pickLine(T.absurd, 'absurd'), after: null };
      }

      // 体力：被缠住脱不开身，-1 体力值（体力见底则直接结束这一天）
      if (r < 0.24 && T.drain && T.drain.length) {
        this.spendStamina(1);
        return {
          lines: this.pickLine(T.drain, 'drain'),
          after: function () { self.restIfExhausted(); }
        };
      }

      // 线索：只抽玩家还没拿到的那些；都拿过了就回落到闲聊
      var pool = (T.clue || []).filter(function (e) { return !self.hasClue(e.id); });
      if (r < 0.5 && pool.length) {
        var entry = this.pickLine(pool, 'clue');
        if (entry) {
          this.addClue(entry.id);
          return { lines: entry.lines, after: null };
        }
      }

      // 闲聊：不给任何东西
      var chat = this.pickLine(T.chatter, 'chatter');
      if (chat) return { lines: chat, after: null };

      // 兜底：所有池都抽不出内容
      return { lines: [{ s: 'villager', t: '（大家看了看你，又各自低下头去，没再说话。）' }], after: null };
    },

    /* 从池里随机取一条，尽量不与上一次同 key 的重复 */
    pickLine: function (pool, key) {
      if (!pool || !pool.length) return null;
      var memo = this._passerbyMemo || (this._passerbyMemo = {});
      var i = Math.floor(Math.random() * pool.length);
      if (pool.length > 1 && memo[key] === i) i = (i + 1) % pool.length;
      memo[key] = i;
      return pool[i];
    },

    talkClerk: function () {
      var n = (this.flag('clerkClicks') || 0) + 1;
      this.setFlag('clerkClicks', n);

      // <2 次：店员为你介绍纪念品
      if (n < 2) {
        var intro = [
          [{ s: 'woman', t: '随便看看，都是佟家岭本地的东西。' },
           { s: 'woman', t: '这些矿石标本是真的，从后山矿脉里取的。' }],
          [{ s: 'woman', t: '这个摆件是本地师傅做的，逢年过节卖得最好。' }]
        ];
        this.say(intro[(n - 1) % intro.length]);
        return;
      }

      // <3 次：店员反问你到底是来干什么的
      if (n < 3) {
        this.say([
          { s: 'woman', t: '你到底是来干什么的？' },
          { s: 'woman', t: '不想买的话，请不要在这里骚扰我。' }
        ]);
        return;
      }

      // >4 次：店员破防，大声咒骂，脱口而出"神脉""圣主"
      if (n > 4 && !this.unlocked('owner_curse')) {
        this.unlock('owner_curse');
        this.addClue('field_curse');
        this.say([
          { s: 'hero', t: '我只想知道，这家店到底是谁开的。' },
          { s: 'woman', t: '（她的手开始抖，声音陡然拔高）你到底有完没完！' },
          { s: 'woman', t: '你以为你是谁？你以为你查得动？' },
          { s: 'woman', t: '……圣主在上，神脉之下，谁都跑不掉！' },
          { s: 'sys', t: '她猛地捂住嘴，像是被自己的话吓了一跳。' },
          { s: 'woman', t: '（她背过身去，不再理我。）' }
        ]);
        return;
      }

      this.say([{ s: 'woman', t: '（她低头擦着柜台，一个字也不肯多说。）' }]);
    },

    tunnelWall: function () {
      var self = this;
      if (this.hasClue('field_wall')) {
        this.say([{ s: 'hero', t: '墙上的符号，和神脉教会网页上的纹样一模一样。' }]);
        return;
      }
      this.addClue('field_wall');
      this.unlock('child_dream');
      this.say([
        { s: 'hero', t: '整面墙刻着同一个符号，一遍又一遍。' },
        { s: 'hero', t: '我见过它——就在神脉教会那个网页上。' },
        { s: 'hero', t: '我照着墙上的顺序，把那个音节念了出来。' },
        { s: 'sys', t: '巷道深处，有什么东西回应了。' },
        { s: 'staff', t: '先生！这里是禁区，不能进入！' },
        { s: 'sys', t: '一个穿制服的人从围挡另一个入口跑过来，跑得很快，脸是白的。' },
        { s: 'staff', t: '马上出去！这里在维护！' },
        { s: 'hero', t: '维护？这地方看着一点施工的样子都没有……' },
        { s: 'sys', t: '他没有回答你，只是一直在推你的后背，把你往那道缝的方向带。出去以后，他从里面把缝用铁丝拧上了。' },
        { s: 'hero', t: '……他们不是怕我进去，是怕我看见里面的东西。' }
      ], function () { self.goto('scenic'); });
    },

    lookExhibit: function () {
      var self = this;
      var n = (this.flag('exhibitLooks') || 0) + 1;
      this.setFlag('exhibitLooks', n);

      if (n === 1) {
        this.say([
          { s: 'hero', t: '一幅矿工合影。照片里的人全都面无表情。' },
          { s: 'hero', t: '说明牌写着"1958 年佟家岭矿区建矿纪念"。' }
        ]);
        return;
      }
      if (n === 2) {
        this.say([
          { s: 'hero', t: '这张画里的巷道，和我在矿洞里看到的一模一样。' },
          { s: 'hero', t: '连墙上那几个符号的位置都对得上。' }
        ]);
        return;
      }

      // 点击 3~10 次：反复端详，越看越不对劲
      if (n <= 10) {
        var more = [
          [{ s: 'hero', t: '……又是这张合影。' }, { s: 'hero', t: '看久了，总觉得照片里有什么地方不对。' }],
          [{ s: 'hero', t: '他们的位置，好像变了。' }, { s: 'hero', t: '（不可能，是我想多了。）' }],
          [{ s: 'hero', t: '（可他们真的在看着我。）' }]
        ];
        this.say(more[(n - 3) % more.length]);
        return;
      }

      // 点击超过 10 次：被赶出展馆；回到景区停顿 5 秒会触发「神之亵渎」
      if (!this.flag('museumExpelled')) {
        this.setFlag('museumExpelled', true);
        this.say([
          { s: 'hero', t: '……不对。' },
          { s: 'hero', t: '画里的矿工，全都抬着头，看着同一个方向。' },
          { s: 'hero', t: '他们看的地方，是我站的位置。' },
          { s: 'sys', t: '展馆的灯闪了一下。' },
          { s: 'woman', t: '（不知从哪走出来）参观结束了，请吧。' },
          { s: 'sys', t: '她一直把我送到大门外，才松开手。' }
        ], function () { self.goto('scenic'); });
        return;
      }
      this.say([{ s: 'hero', t: '还是别看太久了。' }]);
    },

    /* 纪念品商店 · 窗外观察矿石：隔着橱窗反复观察（左右橱窗共用计数），
       每次独白都不同；看够次数后解锁隐藏成就「宝石骑士」。 */
    observeGems: function () {
      var lines = [
        [{ s: 'hero', t: '（橱窗里摆着一排矿石标本，标签写着"佟家岭天然晶脉"，下面一行小字：景区特供。）' }],
        [{ s: 'hero', t: '（打光最足的是那块蓝矿，像有水在里面慢慢流。……这成色，不像几十块钱的旅游纪念品。）' }],
        [{ s: 'hero', t: '（我把脸贴近玻璃看标签背面，印着一行更小的字：非卖品，仅供内部陈列。卖的和留的，是两种石头。）' }],
        [{ s: 'hero', t: '（数了数——左边橱窗三块蓝矿，右边四块。老板把最好的都摆在窗边。不是招客，是给人看。）' }],
        [{ s: 'hero', t: '（玻璃上有一枚新的指纹，正对着最亮的那块。最近有人也在同样的位置，隔着玻璃站了很久。）' }],
        [{ s: 'hero', t: '（越看越眼熟。这些纹路的走向，和矿洞里那面墙上的刻痕是同一种。石头不会说话，摆石头的人会。）' }]
      ];
      var n = (this.flag('gemLooks') || 0) + 1;
      this.setFlag('gemLooks', n);
      if (n <= lines.length) {
        if (n === lines.length) this.unlock('gem_knight');   // 看完最后一幕 → 隐藏成就
        this.say(lines[n - 1]);
        return;
      }
      this.say([{ s: 'hero', t: '（这些石头的纹路，我闭着眼都能描出来了。）' }]);
    },

    /* ==================================================== 下一天 / 结局 == */
    /* 玩家的有效操作推进游戏内时间（不再与现实时间挂钩） */
    advanceTime: function (n) {
      if (!this._inGame || this._ending || this._timeEnding) return;
      if (!n) return;
      this.state.minutes += n;
      this.updateHud();
      this.syncPhoneClock();
      if (this.state.minutes >= DAY_END) this.endDayByTime();
    },

    /* 时间跨过 24:00 → 标记「待结束当天」。真正的收尾（提示 + 独白 + 进入下一天）
       推迟到界面都空下来后由 syncTimeEnd 执行：避免覆盖玩家本次交互刚触发的对白。 */
    endDayByTime: function () {
      if (this._timeEnding || this._ending || this._restPending) return;
      if (!this._inGame) return;
      this._timeEnding = true;
      this.syncTimeEnd();
    },

    /* 待结束当天时每帧兜底：等转场 / 对话 / 面板 / 电脑 / 手机都收起后，播收尾独白并进入下一天 */
    syncTimeEnd: function () {
      if (!this._timeEnding || this._ending || !this._inGame) return;
      if (this._lock) return;   // 转场中，等黑幕落下
      if (this.dlgOpen() || this.panelOpen() || this.computerOpen()) return;
      if (!el.phone.classList.contains('hidden')) return;
      var self = this;
      this.say([
        { s: 'sys', t: '已过 24:00，今天的探索到此结束。' },
        { s: 'hero', t: '（不知不觉已经过了午夜……眼皮沉得抬不起来。剩下的线索，只能明天再查了。）' }
      ], function () {
        self._timeEnding = false;
        self.nextDay();
      });
    },

    nextDay: function () {
      var self = this;
      if (this._lock || this._ending || !this._inGame) return;
      if (this.dlgOpen() || this.panelOpen() || this.computerOpen()) return;

      var d = this.state.date;
      if (d.y === D.END_DATE.y && d.m === D.END_DATE.m && d.d === D.END_DATE.d) {
        this.ending(this.judge());
        return;
      }

      this.fade(function () {
        var nd = new Date(d.y, d.m - 1, d.d + 1);
        self.state.date = { y: nd.getFullYear(), m: nd.getMonth() + 1, d: nd.getDate() };
        self.state.day += 1;
        self.state.minutes = randStartMinutes(self.state.date);
        self.state.stamina = staminaForDate(self.state.date);
        self.state.scene = 'home';
        self.state.x = D.SCENES.home.start;
        self.state.entryX = {};   // 新的一天，各场景站位记忆清零
        self._venuePending = false;   // 新的一天，未结算的探索一并清空
        self.enterScene();
      }, function () {
        var s = self.state;
        self.toast('第 ' + s.day + ' 天 · ' + s.date.m + ' 月 ' + s.date.d + ' 日（' + WEEK[self.weekday()] + '）');
        // 周六：随机插入一段吐槽加班的独白
        if (self.weekday() === 6 && D.SATURDAY_LINES && D.SATURDAY_LINES.length) {
          var pool = D.SATURDAY_LINES;
          self.say(pool[Math.floor(Math.random() * pool.length)]);
        }
      });
    },

    judge: function () {
      var n = Object.keys(this.state.clues).length;
      if (n === 0) return 'idle';
      if (n >= D.TRUTH_LINE) return 'truth';
      if (n <= 4) return 'nodoubt';
      return 'doubt';
    },

    ending: function (kind) {
      var self = this;
      if (this._ending) return;
      this._ending = true;
      this.bumpMetaEndings();   // 累计达成结局次数，满足条件后解锁「深度思考」
      var e = D.ENDINGS[kind];

      this.fade(function () {
        self.clearTimers();
        self.clearAfters();
        el.sceneBg.style.backgroundImage = 'url("../art/结局场景.png")';
        el.sceneBg.style.backgroundSize = 'cover';
        el.sceneBg.style.backgroundPosition = 'center center';
        el.sceneBg.style.filter = 'none';
        el.hero.classList.add('hidden');
        el.hotspotLayer.innerHTML = '';
        el.npcLayer.innerHTML = '';
        el.bottombar.classList.add('hidden');
        self.state.scene = '';
        self.say(e.lines, function () { self.showEndingPanel(kind, e.title); });
      });
    },

    showEndingPanel: function (kind, title) {
      var n = Object.keys(this.state.clues).length;
      var achv = Object.keys(this.state.achv).length;
      var verdict = {
        idle: '你什么都没查，就把钱交了出去。',
        nodoubt: '证据太少，你说服不了自己，也说不了别人。',
        doubt: '你隐约觉得不对，却没能把它说清楚。',
        truth: '你把证据摊开，家人最终选择相信你。'
      }[kind];

      this.openPanel(title, [
        '<p>' + verdict + '</p>',
        '<p class="dim">本次调查：线索 ' + n + ' / ' + Object.keys(D.CLUES).length +
        '　·　成就 ' + achv + ' / ' + Object.keys(D.ACHIEVEMENTS).length + '</p>',
        '<div class="menu-list">',
        '<button type="button" data-p="notes">查看线索笔记</button>',
        '<button type="button" data-p="achv">查看成就</button>',
        '<button type="button" data-p="title">返回标题</button>',
        '</div>'
      ].join(''));
    },

    /* ==================================================== 通用小工具 ==== */
    toast: function (text, ms) {
      var self = this;
      el.toast.textContent = text;
      el.toast.classList.remove('hidden');
      el.toast.classList.remove('show');
      void el.toast.offsetWidth;      // 重启动画
      el.toast.classList.add('show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () {
        el.toast.classList.add('hidden');
        el.toast.classList.remove('show');
      }, ms || 2200);
      return self;
    },

    /* 延时剧情事件：走可暂停计时器，界面打开（面板 / 独白）时一并冻结 */
    after: function (ms, fn) {
      return this.stTimeout(fn, ms);
    },

    clearAfters: function () {
      this.stClearAll();
    },

    /* =========================================== 噩梦成真 · 彩蛋演出 ==== */
    /* 铺垫 + 倒吊人自天花板垂落（#fx 独立于 prop/npc 层，不受对话冻结影响） */
    fxHang: function () {
      if (!el.fx) return;
      el.fx.classList.remove('hidden');
      void el.fx.offsetWidth;      // 强制重排：重启坠落与晃动动画
      el.fx.classList.add('on');
    },

    /* 突脸 scareJump：全屏糊脸 + 红光 + 震屏，约 950ms 后自动收场并回调 */
    fxScare: function (done) {
      var self = this;
      if (el.fxScare) {
        el.fxScare.classList.remove('hidden');
        void el.fxScare.offsetWidth;
        el.fxScare.classList.add('on');
      }
      if (el.viewport) {
        el.viewport.classList.remove('shake');
        void el.viewport.offsetWidth;
        el.viewport.classList.add('shake');
      }
      this.after(950, function () {
        self.fxClear();
        if (done) done();
      });
    },

    fxClear: function () {
      if (el.fx) {
        el.fx.classList.add('hidden');
        el.fx.classList.remove('on');
      }
      if (el.fxScare) {
        el.fxScare.classList.add('hidden');
        el.fxScare.classList.remove('on');
      }
      if (el.viewport) el.viewport.classList.remove('shake');
    },

    spendStamina: function (n) {
      this.state.stamina = Math.max(0, this.state.stamina - n);
      this.updateHud();
    },

    /* 探索一个场馆后回到导览图 / 回家 → 结算 1 点体力（一次探索最多 1 点） */
    _settleVenueVisit: function () {
      if (!this._venuePending) return;
      this._venuePending = false;
      this.spendStamina(1);
      this.restIfExhausted();
    },

    /* 体力耗尽 → 强制休息：按室内 / 室外给出不同独白，随后自动进入下一天（体力制核心规则） */
    restIfExhausted: function () {
      if (this.state.stamina > 0) return;
      if (!this._inGame || this._ending || this._restPending || this._timeEnding) return;
      if (this.dlgOpen() || this.panelOpen() || this.computerOpen()) return;
      if (!el.phone.classList.contains('hidden')) return;
      this._restPending = true;
      var indoor = !!INDOOR_SCENES[this.state.scene];
      var line = indoor
        ? '（忙活了一整天，眼皮都抬不起来了。今天的调查就到这里，先睡吧。）'
        : '（天色暗了下来，腿也迈不动了。今天的探索就到这里，先回住处歇着吧。）';
      var self = this;
      this.say([{ s: 'sys', t: line }], function () {
        self._restPending = false;
        self.nextDay();
      });
    },

    weekday: function () {
      var d = this.state.date;
      return new Date(d.y, d.m - 1, d.d).getDay();
    },

    isSunday: function () { return this.weekday() === 0; },

    pad2: function (n) { return (n < 10 ? '0' : '') + n; },

    updateHud: function () {
      var d = this.state.date;
      var hhmm = this.pad2(Math.floor(this.state.minutes / 60)) + ':' +
        this.pad2(this.state.minutes % 60);
      el.hudDate.textContent = d.y + '年' + d.m + '月' + d.d + '日 ' + WEEK[this.weekday()];
      el.hudTime.textContent = hhmm;
      // 手机主屏状态栏时间跟随游戏内时间
      if (el.phoneStatusTime) el.phoneStatusTime.textContent = hhmm;
      el.hudDay.textContent = '第 ' + this.state.day + ' 天';
      el.hudStamina.textContent = '体力 ' + this.state.stamina;
      // 「一键回家」仅在户外（非室内场景）且进行中显示
      var outdoors = this._inGame && !this._ending &&
        !!this.state.scene && !INDOOR_SCENES[this.state.scene];
      if (el.barHome) el.barHome.classList.toggle('hidden', !outdoors);
      // 「下一天」仅在室内（公寓）可用：户外时禁用
      if (el.barNextday) {
        el.barNextday.disabled = outdoors;
        el.barNextday.title = outdoors ? '在户外无法休息，请先回家' : '';
      }
    },

    /* =================================================== 对外数据接口 ==== */
    hasClue: function (id) { return !!this.state.clues[id]; },

    addClue: function (id) {
      if (!id || this.state.clues[id]) return;
      var c = D.CLUES[id];
      if (!c) return;
      this.state.clues[id] = 1;
      this.toast('获得线索 · ' + c.t);
      this.queueRemark(id);
      this.syncMeta();
      this.checkFlags();
    },

    /* 线索内心独白：有对白在播时直接接在其后，否则缓冲，等下一次 say() 一起播出 */
    queueRemark: function (id) {
      var r = D.CLUE_REMARKS && D.CLUE_REMARKS[id];
      if (!r || !r.length) return;
      if (this.dlgOpen()) this._queue = this._queue.concat(r);
      else this._pendingRemarks = this._pendingRemarks.concat(r);
    },

    /* 同步独立播出缓冲的独白：用于网页线索（电脑 / 手机界面打开、定时器被冻结时） */
    flushRemarks: function () {
      if (!this._pendingRemarks.length) return;
      var r = this._pendingRemarks;
      this._pendingRemarks = [];
      this.say(r);
    },

    /* 有线索的网页：不自动定位，交由玩家自行滚动翻找。
       向 iframe 下发 web:clue；网页内线索元素进入视口中心带（1/4~3/4）时，网页会自行居中并回报。 */
    watchWebClue: function (which, page, keyword, clue, achv) {
      if (!keyword) return;
      this._webClueWatch = { which: which, page: page, keyword: keyword, clue: clue, achv: achv || '' };
      var view = which === 'phone' ? el.phoneView : el.compView;
      try {
        view.contentWindow.postMessage({ type: 'web:clue', keyword: keyword }, '*');
      } catch (e) { /* iframe 尚未就绪时忽略 */ }
    },

    /* iframe 内玩家滚动使线索元素进入视口中心带 → 网页已自行居中；此处补发线索与内心独白（仅第一次） */
    onWebClueFound: function (page) {
      var w = this._webClueWatch;
      if (!w || w.page !== page) return;
      this._webClueWatch = null;
      this.addClue(w.clue);
      this.flushRemarks();
      if (w.achv) this.unlock(w.achv);
    },

    unlock: function (id) {
      if (!id || this.state.achv[id]) return;
      var a = D.ACHIEVEMENTS[id];
      if (!a) return;
      this.state.achv[id] = 1;
      this.toast('解锁成就 · ' + a.t);
      this.syncMeta();
    },

    unlocked: function (id) { return !!this.state.achv[id]; },

    /* 记录一次矿洞区域的到访；走遍六区 → 「井下巡线」 */
    visitRoom: function (id) {
      var s = this.state;
      s.rooms = s.rooms || {};
      if (s.rooms[id]) return;
      s.rooms[id] = 1;
      var all = MINE_ROOMS.every(function (r) { return s.rooms[r]; });
      if (all) this.unlock('mine_roam');
    },

    state: null,

    flag: function (k) { return this.state.flags[k]; },

    setFlag: function (k, v) { this.state.flags[k] = v; },

    /* 线索齐备后派生出的剧情开关 */
    checkFlags: function () {
      var s = this.state;
      // 三条旧线索串起矿洞核心疑点（不再锁死入口，矿井改造后仍需可反复探索）
      if (!s.flags.mineCore &&
          s.clues.field_tunnel && s.clues.field_forbidden && s.clues.field_wall) {
        s.flags.mineCore = true;
        this.toast('矿洞深处的三个疑点已经串起来了');
      }
      // 集齐矿洞全部九条线索 → 「井下全记录」
      if (!this.unlocked('mine_all')) {
        var ids = ['field_tunnel', 'field_forbidden', 'field_wall',
                   'mine_debris', 'mine_pick', 'mine_timber',
                   'mine_lamp_oil', 'mine_water', 'mine_vein'];
        var all = true;
        for (var i = 0; i < ids.length; i++) {
          if (!s.clues[ids[i]]) { all = false; break; }
        }
        if (all) this.unlock('mine_all');
      }
      if (!s.flags.catGone && s.flags.hasHam) { /* 交火腿肠由热点自行处理 */ }
    },

    /* ======================================================== 事件绑定 == */
    bindGlobal: function () {
      var self = this;

      window.addEventListener('resize', function () { self.resize(); });

      // 浏览器自动播放策略：无用户手势时主题曲会被拦截。
      // 首次交互即解锁音频：若此前是静音起播，此刻取消静音立即出声。
      ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) {
        window.addEventListener(t, function () {
          if (self._titleBgmWanted) self.playTitleBgm();
          self.resumeTitleBgmSound();
        }, true);
      });

      // 任意输入都视为「非静置」，重置静置计时（用于深度思考按钮显现）
      ['keydown', 'mousedown', 'touchstart', 'wheel'].forEach(function (t) {
        window.addEventListener(t, function () { self._idleT = 0; }, true);
      });

      window.addEventListener('keydown', function (ev) {
        var k = ev.key;
        // 改键捕获态：拦截一切按键，捕获到的新键写入配置（Esc 取消）
        if (self._rebind) {
          ev.preventDefault();
          var nk = normKey(k);
          if (k === 'Escape') { self._rebind = null; self.showSettings(); return; }
          if (RESERVED_KEYS[nk]) { self.toast('该按键已被占用，请换一个'); return; }
          self._keyMap[self._rebind] = nk;
          self.saveKeys();
          self._rebind = null;
          self.showSettings();
          return;
        }
        if (k === 'a' || k === 'A' || k === 'ArrowLeft') { self._keys.left = true; ev.preventDefault(); }
        else if (k === 'd' || k === 'D' || k === 'ArrowRight') { self._keys.right = true; ev.preventDefault(); }
        else if (k === ' ' || normKey(k) === self._keyMap.interact) {
          if (self.dlgOpen()) { self.advance(); ev.preventDefault(); }
          else if (self.interact()) ev.preventDefault();
        } else if (k === 'Enter') {
          if (self.dlgOpen()) { self.advance(); ev.preventDefault(); }
          else if (self.panelOpen() && self._nearPick && self._nearPick.length) {
            self.pickNear(0); ev.preventDefault();
          }
        } else if (k === 'Control') {
          self._ctrlHeld = true;      // 按住 Ctrl 加速对话
        } else if (k === 'Escape') {
          self.onEscape();
        } else if (k === 'f' || k === 'F') {
          el.bottombar.classList.toggle('collapsed');
        } else if (k === 'F12') {
          // 电脑开着且当前页面可调试时，F12 唤出「开发者工具 · 网络」面板（独白期间冻结操作）
          if (!self.dlgOpen() && self.computerOpen() && self._dev) { self.toggleDevtools(); ev.preventDefault(); }
        }
      });

      window.addEventListener('keyup', function (ev) {
        var k = ev.key;
        if (k === 'a' || k === 'A' || k === 'ArrowLeft') self._keys.left = false;
        else if (k === 'd' || k === 'D' || k === 'ArrowRight') self._keys.right = false;
        else if (k === 'Control') self._ctrlHeld = false;
      });

      // 失焦时清掉按键状态，避免 Ctrl/方向键"卡住"
      window.addEventListener('blur', function () {
        self._ctrlHeld = false;
        self._keys.left = self._keys.right = false;
      });

      // 对话 / 舞台：点击任意处推进
      el.dialogue.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self.advance();
      });
      el.dlgSkip.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self.skipSeen();
      });
      el.stage.addEventListener('click', function () {
        if (self.dlgOpen()) self.advance();
      });

      // HUD 菜单
      el.hudMenu.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!self._inGame || self._ending) return;
        self.showMenu();
      });

      // 导览图右上角：回到景区门口
      if (el.mapBack) el.mapBack.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!self._inGame || self._ending || self._lock) return;
        self.goto('gate');
      });

      // 底栏
      el.barToggle.addEventListener('click', function (ev) {
        ev.stopPropagation();
        el.bottombar.classList.toggle('collapsed');
      });
      el.barItems.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-act]');
        if (!b) return;
        ev.stopPropagation();
        var a = b.getAttribute('data-act');
        if (a === 'phone') self.openPhone();
        else if (a === 'nextday') {
          if (self._lock || self._ending || !self._inGame) return;
          self.say([{ s: 'hero', t: '（今天就到这儿吧，睡一觉，明天接着查。）' }], function () {
            self.nextDay();
          });
        }
        else if (a === 'think') self.deepThink();
        else if (a === 'home') self.goHome();
      });

      // 面板
      el.panelClose.addEventListener('click', function () { self.closePanel(); });
      el.panel.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (ev.target === el.panel) self.closePanel();
      });
      el.panelBody.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-p]');
        if (!b) return;
        var p = b.getAttribute('data-p');
        if (p === 'cancel') self.closePanel();
        else if (p === 'near') self.pickNear(parseInt(b.getAttribute('data-near'), 10));
        else if (p === 'menu') self.showMenu();
        else if (p === 'notes') self.showNotes();
        else if (p === 'achv') self.showAchievements();
        else if (p === 'settings') self.showSettings();
        else if (p === 'save') self.showSlots('save');
        else if (p === 'load') self.showSlots('load');
        else if (p === 'slot') self.slotChosen(b.getAttribute('data-n'), b.getAttribute('data-mode'));
        else if (p === 'title') self.backToTitle();
        else if (p === 'newgo') self.startNew();
        else if (p === 'wipe') self.wipeAll();
      });

      // 全屏档案页
      el.pageClose.addEventListener('click', function () { self.closePage(); });
      el.page.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (ev.target === el.page) self.closePage();
      });
      el.pageBody.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-pg]');
        if (!b) return;
        var pg = b.getAttribute('data-pg');
        if (pg === 'wipe') { self.wipeAll(); self.showSettings(); }
        else if (pg === 'rebind') { self.startRebind(b.getAttribute('data-key') || 'interact'); }
      });

      // 电脑
      el.compClose.addEventListener('click', function (ev) { ev.stopPropagation(); self.closeComputer(); });
      el.compBack.addEventListener('click', function (ev) { ev.stopPropagation(); self.browserBack('comp'); });
      el.compNet.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var page = ev.target.closest('[data-page]');
        if (page) {
          ev.preventDefault();
          self.loadPage(page.getAttribute('data-page'));
          return;
        }
        var req = ev.target.closest('[data-req]');
        if (req) {
          ev.preventDefault();
          self.showNetPreview();
        }
      });
      el.compView.addEventListener('load', function () { self.onComputerLoad(); });
      el.computer.addEventListener('click', function (ev) { ev.stopPropagation(); });

      // 手机
      el.phoneClose.addEventListener('click', function (ev) { ev.stopPropagation(); self.closePhone(); });
      // 主屏图标：浏览器单独走网页通道，其余 10 个应用走统一的应用框架
      el.phoneHome.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var b = ev.target.closest('.phone-app-btn');
        if (!b) return;
        var app = b.getAttribute('data-app');
        if (app === 'browser') self.phoneOpenBrowser('search.html');
        else self.openPhoneApp(app);
      });
      el.phoneAppBack.addEventListener('click', function (ev) { ev.stopPropagation(); self.phoneAppBack(); });
      el.phoneAppBody.addEventListener('click', function (ev) { ev.stopPropagation(); self.onPhoneAppClick(ev); });
      el.phoneAppBody.addEventListener('input', function (ev) { self.onPhoneAppInput(ev); });
      el.phoneBack.addEventListener('click', function (ev) { ev.stopPropagation(); self.phoneHome(); });
      el.phoneBackPage.addEventListener('click', function (ev) { ev.stopPropagation(); self.browserBack('phone'); });
      el.phoneView.addEventListener('load', function () { self.onPhoneLoad(); });
      el.phone.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (ev.target === el.phone) self.closePhone();
      });

      // 网页 → 游戏：搜索页反复搜索无关内容满 10 次
      window.addEventListener('message', function (ev) {
        if (ev.source !== el.compView.contentWindow && ev.source !== el.phoneView.contentWindow) return;
        var d = ev.data || {};
        // 独白 / 对话播放期间：网页若仍持有焦点，其发来的「开面板 / 反复搜索」一律忽略
        if (self.dlgOpen() && (d.type === 'devtools:open' || d.type === 'search:irrelevant10')) return;
        if (d.type === 'search:irrelevant10') {
          self.spendStamina(1);
          self.unlock('not_domestic');
        } else if (d.type === 'web:page' && typeof d.page === 'string') {
          // iframe 网页自报当前文件名：file:// 不透明源下父窗口读不到 location，靠这条通道
          var which = ev.source === el.compView.contentWindow ? 'comp' : 'phone';
          self.applyWebPage(which, d.page);
        } else if (d.type === 'web:clue-found' && typeof d.page === 'string') {
          // iframe 内线索元素进入视口中心带（玩家自行翻找命中）→ 发放线索并触发内心独白
          self.onWebClueFound(d.page);
        } else if (d.type === 'devtools:open') {
          // iframe（官网）内按下 F12：由父窗口唤出「开发者工具 · 网络」面板
          self.toggleDevtools();
        }
      });

      // 标题页
      el.title.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-act]');
        if (!b) return;
        ev.stopPropagation();
        var a = b.getAttribute('data-act');
        if (a === 'new') self.confirmNew();
        else if (a === 'continue') self.continueGame();
        else if (a === 'load') self.showSlots('load');
        else if (a === 'notes') self.showNotes();
        else if (a === 'achv') self.showAchievements();
        else if (a === 'settings') self.showSettings();
      });
    },

    /* Esc：按 档案页 → 电脑 → 手机浏览器 → 手机 → 面板 → 游戏菜单 的优先级逐层关闭 */
    onEscape: function () {
      // 对话 / 独白进行中：Esc 只收掉对白，不得操作其下的界面（如电脑 / 手机）
      if (this.dlgOpen()) { this.closeDialogue(); return; }
      if (this.pageOpen()) { this.closePage(); return; }
      if (this.computerOpen()) { this.closeComputer(); return; }
      if (!el.phone.classList.contains('hidden')) {
        if (!el.phoneApp.classList.contains('hidden')) this.phoneAppBack();
        else if (!el.phoneBrowser.classList.contains('hidden')) this.phoneHome();
        else this.closePhone();
        return;
      }
      // 结局结算：此刻底栏已隐藏、场景为空，没有常规出口；任意 Esc 一律回到标题
      if (this._ending) { this.backToTitle(); return; }
      if (this.panelOpen()) { this.closePanel(); return; }
      if (this._inGame) this.showMenu();
    }
  };

  return Game;
})();
