// Vocabulary and art direction from the approved gouki prototype (2026-11-08).
export const CONFIG = [
  {
    "id": "source",
    "title": "母体",
    "english": "SOURCE",
    "tags": [
      "动物",
      "植物",
      "日常物品",
      "自然现象",
      "职业",
      "神话",
      "工业",
      "建筑",
      "食物",
      "乐器",
      "交通工具",
      "天文"
    ]
  },
  {
    "id": "concept",
    "title": "跨界概念",
    "english": "CROSSOVER",
    "tags": [
      "远古文明",
      "街头文化",
      "海洋探索",
      "节庆民俗",
      "蒸汽科技",
      "梦境",
      "童话",
      "美食文化",
      "竞技运动",
      "太空旅行",
      "戏曲",
      "深海科研"
    ]
  },
  {
    "id": "mechanism",
    "title": "机制",
    "optional": true,
    "english": "MECHANISM",
    "tags": [
      "形态变化类",
      "展开折叠类",
      "共生互动类",
      "重力空间类",
      "能量反馈类",
      "模块拼装类",
      "机关收纳类",
      "弹射传动类",
      "状态切换类",
      "牵引联动类",
      "旋转结构类",
      "磁力吸附类",
      "不强调机制",
      "无外置机关"
    ]
  },
  {
    "id": "personality",
    "title": "性格",
    "optional": true,
    "english": "PERSONALITY",
    "tags": [
      "开朗乐观型",
      "坚持原则型",
      "反差矛盾型",
      "聪明机敏型",
      "温柔保护型",
      "外向表现型",
      "冷静理智型",
      "好奇探索型",
      "内向安静型",
      "幽默古怪型",
      "竞争好胜型",
      "慢热谨慎型"
    ]
  },
  {
    "id": "equipment",
    "title": "道具与装备",
    "english": "EQUIPMENT",
    "optional": true,
    "tags": [
      "防护装备类",
      "辅助工具类",
      "近战道具类",
      "远程道具类",
      "反馈装置类",
      "解锁工具类",
      "探索仪器类",
      "移动装备类",
      "导航道具类",
      "生活器具类",
      "复合功能类",
      "收纳携行类"
    ]
  },
  {
    "id": "signature",
    "title": "识别特征",
    "english": "SIGNATURE",
    "optional": true,
    "tags": [
      "局部缺损类",
      "伤痕旧迹类",
      "口部特征类",
      "左右不对称类",
      "图形斑纹类",
      "修补痕迹类",
      "表面磨损类",
      "异色标记类",
      "面部轮廓类",
      "末端结构类",
      "材质肌理类",
      "肢体比例类"
    ]
  },
  {
    "id": "entity",
    "title": "组合形态",
    "english": "COMPOSITION",
    "optional": true,
    "tags": [
      "双体组合类",
      "共生组合类",
      "主从搭档类",
      "上下叠合类",
      "分体重组类",
      "多体群组类",
      "套叠结构类",
      "镜像组合类",
      "骑乘共体类",
      "双面结构类",
      "多意识共体类",
      "对称关联类"
    ]
  },
  {
    "id": "physique",
    "title": "形体轮廓",
    "english": "SILHOUETTE",
    "optional": true,
    "tags": [
      "上下比例类",
      "重心分布类",
      "肢体比例类",
      "头身比例类",
      "曲线轮廓类",
      "角形轮廓类",
      "球形体块类",
      "锥形体块类",
      "非对称体型",
      "细长体量类",
      "宽窄对比类",
      "主体体块类"
    ]
  }
] as const;

export const DEFAULT_REQUIREMENTS = "家庭向精品3D卡通风格，2.5头身，圆润简洁的几何体块，鲜明纯净的配色，强剪影，高辨识度，半哑光材质，柔和棚拍光，可爱但不低幼，明确的厚度与装配关系，便于3D建模和动画制作。";

export const SOURCES = {
  "动物": [
    {
      "name": "海獭",
      "shape": "圆脸、宽掌与流线形短身躯",
      "anchor": "厚实的双掌",
      "root": "潮掌"
    },
    {
      "name": "蜗牛",
      "shape": "圆润螺旋壳与软质短触角",
      "anchor": "螺旋背壳",
      "root": "螺旋"
    },
    {
      "name": "企鹅",
      "shape": "水滴形身躯与短小鳍翅",
      "anchor": "两侧鳍翅",
      "root": "黑鳍"
    },
    {
      "name": "穿山甲",
      "shape": "层叠甲片和低重心体态",
      "anchor": "层叠背甲",
      "root": "鳞甲"
    },
    {
      "name": "水豚",
      "shape": "方圆结合的躯干与平静面部",
      "anchor": "大体块背部",
      "root": "水豚"
    },
    {
      "name": "螃蟹",
      "shape": "横向宽壳和夸张钳肢",
      "anchor": "可开合的双钳",
      "root": "赤钳"
    }
  ],
  "植物": [
    {
      "name": "蒲公英",
      "shape": "球形绒冠与细长茎躯",
      "anchor": "伞状冠毛",
      "root": "风絮"
    },
    {
      "name": "仙人掌",
      "shape": "柱形主躯与分叉短臂",
      "anchor": "节状枝干",
      "root": "绿刺"
    },
    {
      "name": "松果",
      "shape": "层层叠起的椭圆鳞片",
      "anchor": "层状鳞片",
      "root": "松鳞"
    },
    {
      "name": "蘑菇",
      "shape": "大帽檐和紧凑的菌柄体块",
      "anchor": "宽大的伞盖",
      "root": "菌伞"
    }
  ],
  "日常物品": [
    {
      "name": "老式怀表",
      "shape": "圆盘主体与外露表冠",
      "anchor": "表盘与表链",
      "root": "时针"
    },
    {
      "name": "折叠雨伞",
      "shape": "圆顶伞面和伸缩骨架",
      "anchor": "辐射状伞骨",
      "root": "伞骨"
    },
    {
      "name": "保温壶",
      "shape": "短胖壶身与弧形手柄",
      "anchor": "壶嘴与握柄",
      "root": "暖壶"
    },
    {
      "name": "纸灯笼",
      "shape": "鼓起的灯罩与环形骨架",
      "anchor": "灯笼骨圈",
      "root": "纸灯"
    }
  ],
  "自然现象": [
    {
      "name": "小型积雨云",
      "shape": "三团相连的蓬松云体",
      "anchor": "层叠云团",
      "root": "雨团"
    },
    {
      "name": "极光",
      "shape": "流动的带状轮廓与明亮核心",
      "anchor": "弧形光带",
      "root": "极光"
    },
    {
      "name": "漩涡",
      "shape": "旋转的同心曲线体块",
      "anchor": "涡旋核心",
      "root": "漩心"
    },
    {
      "name": "闪电",
      "shape": "折线主轮廓与圆角转折",
      "anchor": "折线闪电臂",
      "root": "闪弧"
    }
  ],
  "职业": [
    {
      "name": "邮差",
      "shape": "结实短腿与方形邮包轮廓",
      "anchor": "背包与肩带",
      "root": "邮袋"
    },
    {
      "name": "修理匠",
      "shape": "厚手套与工具腰带",
      "anchor": "工具带",
      "root": "扳手"
    },
    {
      "name": "烘焙师",
      "shape": "高帽与圆鼓围裙体块",
      "anchor": "厨师帽",
      "root": "面团"
    },
    {
      "name": "园艺师",
      "shape": "大口袋围裙和可拆卸手套",
      "anchor": "收纳口袋",
      "root": "花剪"
    }
  ],
  "神话": [
    {
      "name": "石狮守护灵",
      "shape": "宽额、大爪与紧凑鬃毛",
      "anchor": "层叠石鬃",
      "root": "石狮"
    },
    {
      "name": "小麒麟",
      "shape": "圆角短角与饱满胸甲",
      "anchor": "一对短角",
      "root": "麟角"
    },
    {
      "name": "山灵",
      "shape": "石块堆叠的躯干与小树冠",
      "anchor": "山石肩部",
      "root": "山岩"
    },
    {
      "name": "风精灵",
      "shape": "球形核心与丝带式手臂",
      "anchor": "环绕风带",
      "root": "风带"
    }
  ],
  "工业": [
    {
      "name": "卷线器",
      "shape": "大圆轮与侧置把手",
      "anchor": "中央线轴",
      "root": "卷轴"
    },
    {
      "name": "齿轮箱",
      "shape": "方圆相切的厚壳与圆齿",
      "anchor": "外缘齿轮",
      "root": "齿箱"
    },
    {
      "name": "液压千斤顶",
      "shape": "矮胖底座与伸缩圆柱",
      "anchor": "升降活塞",
      "root": "液压"
    },
    {
      "name": "磁力起重机",
      "shape": "圆角承重臂和悬吊端头",
      "anchor": "吊臂末端",
      "root": "磁吊"
    }
  ],
  "建筑": [
    {
      "name": "灯塔",
      "shape": "上窄下宽的塔身与环形顶盖",
      "anchor": "顶部灯室",
      "root": "灯塔"
    },
    {
      "name": "风车屋",
      "shape": "圆屋顶与十字风叶",
      "anchor": "正面风叶",
      "root": "风叶"
    },
    {
      "name": "拱桥",
      "shape": "清晰拱形与厚重桥墩",
      "anchor": "拱形主体",
      "root": "桥拱"
    },
    {
      "name": "钟楼",
      "shape": "层叠方塔与圆形钟面",
      "anchor": "中央大钟",
      "root": "钟塔"
    }
  ],
  "食物": [
    {
      "name": "牛角面包",
      "shape": "两端卷曲的金色弧体",
      "anchor": "层状卷角",
      "root": "酥角"
    },
    {
      "name": "糯米团",
      "shape": "圆球形软糯主躯与小短肢",
      "anchor": "柔软圆腹",
      "root": "糯团"
    },
    {
      "name": "爆米花",
      "shape": "不规则圆团组合与纸杯轮廓",
      "anchor": "蓬松冠部",
      "root": "爆花"
    },
    {
      "name": "甜甜圈",
      "shape": "厚实环形与中央圆孔",
      "anchor": "环形轮廓",
      "root": "甜环"
    }
  ],
  "乐器": [
    {
      "name": "手风琴",
      "shape": "矩形琴箱与可伸缩风箱",
      "anchor": "折叠风箱",
      "root": "风箱"
    },
    {
      "name": "小号",
      "shape": "卷曲铜管与喇叭口",
      "anchor": "扩张喇叭口",
      "root": "铜号"
    },
    {
      "name": "木琴",
      "shape": "并排宽音条和短支架",
      "anchor": "排列音条",
      "root": "音条"
    },
    {
      "name": "留声机",
      "shape": "大喇叭口与小方机座",
      "anchor": "号角形声筒",
      "root": "声筒"
    }
  ],
  "交通工具": [
    {
      "name": "独轮车",
      "shape": "中心大轮与紧凑车架",
      "anchor": "圆形轮毂",
      "root": "独轮"
    },
    {
      "name": "潜水艇",
      "shape": "胶囊形船身与圆窗",
      "anchor": "透明观察窗",
      "root": "潜艇"
    },
    {
      "name": "热气球",
      "shape": "大球体与悬挂式吊篮",
      "anchor": "悬挂绳索",
      "root": "热球"
    },
    {
      "name": "复古电车",
      "shape": "方圆相间的车厢与小轮组",
      "anchor": "车顶受电弓",
      "root": "电车"
    }
  ],
  "天文": [
    {
      "name": "小行星",
      "shape": "多面圆角石块与发光裂隙",
      "anchor": "岩石裂隙",
      "root": "星砾"
    },
    {
      "name": "彗星",
      "shape": "球形星核与拖尾弧带",
      "anchor": "流线尾迹",
      "root": "彗尾"
    },
    {
      "name": "土星环",
      "shape": "圆球主体与倾斜大环",
      "anchor": "外侧环带",
      "root": "星环"
    },
    {
      "name": "月牙",
      "shape": "柔和弯月轮廓与弧形内凹",
      "anchor": "月牙弧线",
      "root": "新月"
    }
  ]
};

export const CONCEPTS = {
  "远古文明": [
    {
      "name": "遗迹探路员",
      "prop": "石刻罗盘",
      "mood": "古老石纹与仪式感",
      "suffix": "遗迹使"
    },
    {
      "name": "星图考古家",
      "prop": "可拼接星图",
      "mood": "铭文和几何刻线",
      "suffix": "寻星者"
    }
  ],
  "街头文化": [
    {
      "name": "涂鸦快递员",
      "prop": "喷绘式信号徽记",
      "mood": "大胆图形与俏皮节奏",
      "suffix": "涂鸦客"
    },
    {
      "name": "节拍滑行家",
      "prop": "折叠滑行板",
      "mood": "撞色条纹和律动",
      "suffix": "节拍手"
    }
  ],
  "海洋探索": [
    {
      "name": "深海领航员",
      "prop": "发光航海罗盘",
      "mood": "海蓝色导航标记",
      "suffix": "领航员"
    },
    {
      "name": "潮汐邮差",
      "prop": "浮力邮包",
      "mood": "波浪曲线与海图符号",
      "suffix": "潮汐信使"
    }
  ],
  "节庆民俗": [
    {
      "name": "巡游灯彩师",
      "prop": "层层展开的灯彩",
      "mood": "节庆纹样和秩序感",
      "suffix": "灯彩师"
    },
    {
      "name": "鼓点仪仗员",
      "prop": "节奏鼓槌",
      "mood": "高对比色块与传统纹饰",
      "suffix": "鼓点使"
    }
  ],
  "蒸汽科技": [
    {
      "name": "蒸汽修补匠",
      "prop": "压力刻度盘",
      "mood": "铜色仪表与机械铆接",
      "suffix": "蒸汽匠"
    },
    {
      "name": "发条巡检员",
      "prop": "可上弦密钥",
      "mood": "复古表盘和精密齿轮",
      "suffix": "发条使"
    }
  ],
  "梦境": [
    {
      "name": "梦境收集员",
      "prop": "透明梦泡容器",
      "mood": "柔和渐层与漂浮符号",
      "suffix": "捕梦人"
    },
    {
      "name": "午夜寻梦者",
      "prop": "可旋转睡梦星图",
      "mood": "弯月符号和轻盈姿态",
      "suffix": "寻梦者"
    }
  ],
  "童话": [
    {
      "name": "森林故事管理员",
      "prop": "会翻页的故事盒",
      "mood": "绘本式几何图形",
      "suffix": "故事员"
    },
    {
      "name": "魔法邮局学徒",
      "prop": "封蜡印章",
      "mood": "温暖童话纹章",
      "suffix": "邮局学徒"
    }
  ],
  "美食文化": [
    {
      "name": "风味调配师",
      "prop": "分层调味盘",
      "mood": "食材色彩与器皿纹路",
      "suffix": "风味师"
    },
    {
      "name": "流动甜品师",
      "prop": "可折叠甜品架",
      "mood": "奶油弧线与糖果配色",
      "suffix": "甜品匠"
    }
  ],
  "竞技运动": [
    {
      "name": "反重力球员",
      "prop": "悬浮计分环",
      "mood": "数字赛场标志",
      "suffix": "球场新星"
    },
    {
      "name": "极限接力手",
      "prop": "多段接力棒",
      "mood": "速度线与运动护具",
      "suffix": "接力王"
    }
  ],
  "太空旅行": [
    {
      "name": "星际快递员",
      "prop": "轨道导航包",
      "mood": "太空徽章与舱体模块",
      "suffix": "星际信使"
    },
    {
      "name": "迷你行星导游",
      "prop": "掌上轨道仪",
      "mood": "天体图形和鲜明面板",
      "suffix": "星球导游"
    }
  ],
  "戏曲": [
    {
      "name": "戏台机关师",
      "prop": "可展开的戏台扇",
      "mood": "戏曲脸谱的几何配色",
      "suffix": "戏台匠"
    },
    {
      "name": "巡游武生",
      "prop": "折叠式戏曲靠旗",
      "mood": "利落旗帜与节奏韵律",
      "suffix": "小武生"
    }
  ],
  "深海科研": [
    {
      "name": "微光观测员",
      "prop": "球形观测探针",
      "mood": "深海荧光与科研标记",
      "suffix": "观测员"
    },
    {
      "name": "海沟标本师",
      "prop": "透明标本仓",
      "mood": "清晰的刻度与层次",
      "suffix": "标本师"
    }
  ]
};

export const MECHANISMS = {
  "不强调机制": { "cn": "以角色自然姿态与行为表现为主，不强调机关", "en": "focus on natural posture and behavior without emphasizing mechanisms" },
  "无外置机关": { "cn": "通过自身组织与内部结构表达作用，不添加外置机关", "en": "express function through natural tissue and internal structures without external mechanisms" },
  "变形结构": {
    "cn": "背部折叠机构分为三节，动作时从收纳形切换为工作形",
    "en": "a three-stage folding assembly switches from compact to working form"
  },
  "可展开道具": {
    "cn": "核心道具沿铰链呈扇形打开，收起时与身体轮廓融为一体",
    "en": "a hinged fan-shaped tool unfolds and folds flush into the silhouette"
  },
  "共生配件": {
    "cn": "小型伴生装置以可拆卸连接点环绕主体移动，并协同完成动作",
    "en": "detachable companion devices orbit the body and cooperate through visible joints"
  },
  "重力反转": {
    "cn": "脚下悬浮环改变朝向，产生上下翻转的重心变化和明确的运动轨迹",
    "en": "a floating ring redirects gravity and changes the center of mass visibly"
  },
  "蓄能反馈": {
    "cn": "旋钮蓄力带动外层刻度逐格亮起，释放时体块张开形成强烈前后对比",
    "en": "a wind-up dial illuminates in stages before the shell releases its stored energy"
  },
  "模块拼装": {
    "cn": "四块大模块通过统一接口替换与重组，形状变化清晰可读",
    "en": "four chunky modules recombine through consistent mechanical sockets"
  },
  "收纳机关": {
    "cn": "身体侧面隐藏抽屉式装备仓，拉出后形成完整可用的工具",
    "en": "a slide-out equipment drawer reveals a functional tool"
  },
  "弹射装置": {
    "cn": "压缩弹簧储能后弹出圆角装置，轨道和回收结构清楚可见",
    "en": "a compressed spring launches a soft-edged tool along a visible guide rail"
  },
  "形态切换": {
    "cn": "通过环形枢轴切换两种功能姿态，关键体块保持一致",
    "en": "a ring pivot toggles between two functional poses while preserving core volumes"
  },
  "牵引绳": {
    "cn": "绳索同时承担手臂与牵引功能，连接后挂环并能拉动配件",
    "en": "a tether doubles as an arm and pulls attachments from a rear anchor ring"
  },
  "旋转关节": {
    "cn": "大尺寸旋转轴带动肩部与道具旋转，轴心明确且运动范围直观",
    "en": "oversized rotary joints drive the shoulder tool with a legible center of rotation"
  },
  "磁吸组合": {
    "cn": "两个厚实的磁吸端口吸合成新工具，接口形状与锁定反馈一致",
    "en": "two chunky magnetic ports snap together into a new functional tool"
  }
};

export const PERSONALITIES = {
  "乐天": {
    "pose": "微微前倾的跳跃姿势与明快手势",
    "en": "joyful, leaning forward in a buoyant pose"
  },
  "固执": {
    "pose": "双脚稳稳站定、下巴微抬",
    "en": "stubborn, feet firmly planted with chin slightly raised"
  },
  "胆小但勇敢": {
    "pose": "躯干稍微后缩却主动伸出一只手",
    "en": "timid but brave, body recoiling while one arm reaches ahead"
  },
  "机灵": {
    "pose": "侧倾重心、眼神聚焦、手势迅速",
    "en": "clever, shifting weight with an alert focused gaze"
  },
  "温柔可靠": {
    "pose": "宽稳的站姿和保护性的环抱动作",
    "en": "warm and dependable, stable stance with protective gestures"
  },
  "爱炫耀": {
    "pose": "一只手托起核心道具、另一只手指向自己",
    "en": "showy, proudly presenting the signature tool"
  },
  "沉稳": {
    "pose": "对称而从容的站姿与低幅度动作",
    "en": "composed, standing with calm symmetrical balance"
  },
  "冒险": {
    "pose": "大步迈出、身体面向未知方向",
    "en": "adventurous, striding forward with strong directional movement"
  },
  "害羞": {
    "pose": "肩部微收、轻轻藏起一件小道具",
    "en": "shy, shoulders tucked while hiding a small prop"
  },
  "古怪": {
    "pose": "不对称站姿和出其不意的头部倾斜",
    "en": "eccentric, asymmetrical stance with a curious head tilt"
  },
  "好胜": {
    "pose": "前脚踏出、核心道具高举准备比试",
    "en": "competitive, stepping forward with tool raised"
  },
  "慢热": {
    "pose": "安静观察的初始姿势与逐渐舒展的动作",
    "en": "reserved at first, slowly opening into a welcoming pose"
  }
};

export const LEGACY_TAGS = {
  "mechanism": [
    "变形结构",
    "可展开道具",
    "共生配件",
    "重力反转",
    "蓄能反馈",
    "模块拼装",
    "收纳机关",
    "弹射装置",
    "形态切换",
    "牵引绳",
    "旋转关节",
    "磁吸组合",
    "不强调机制",
    "无外置机关"
  ],
  "personality": [
    "乐天",
    "固执",
    "胆小但勇敢",
    "机灵",
    "温柔可靠",
    "爱炫耀",
    "沉稳",
    "冒险",
    "害羞",
    "古怪",
    "好胜",
    "慢热"
  ],
  "equipment": [
    "反向雨伞盾",
    "折叠尾巴工具",
    "磁吸双头锤",
    "邮戳弹弓",
    "会计数的纽扣",
    "可伸缩钥匙环",
    "背包式灯塔",
    "章鱼吸盘鞋",
    "地图卷轴鞭",
    "可翻面的锅盖",
    "风向标长枪",
    "变形钓竿"
  ],
  "signature": [
    "缺角耳朵",
    "脸颊浅疤",
    "断了半颗门牙",
    "不对称短角",
    "星形眼周斑",
    "补丁缝线",
    "磨损的护肩",
    "异色手套",
    "缺口形眉毛",
    "尾巴末端打结",
    "褪色鳞片",
    "一长一短的手臂"
  ],
  "entity": [
    "双胞胎合体",
    "共生双角色",
    "主角与卫星搭档",
    "上下半身合作",
    "可分离二人组",
    "三段分身重组",
    "亲子套娃",
    "反向影子搭档",
    "主角坐骑共体",
    "双面角色",
    "一体双意识",
    "镜像兄弟"
  ],
  "physique": [
    "上大下小",
    "桶形低重心",
    "长腿短躯",
    "短肢大头",
    "水滴形身躯",
    "倒三角上身",
    "大圆腹",
    "锥形身体",
    "左右不对称",
    "轻盈细长",
    "超宽肩窄脚",
    "球形主躯"
  ]
};

export const DETAIL_ALTS = {
  "equipment": [
    "能反扣为浮力救生舱的肩盾",
    "腰间自动展开的折尺修复台",
    "双端通过齿轮同步的软边工具锤",
    "沿尾环轨道发射彩色信标的弹弓",
    "根据脚步节奏亮起的肩部计数器",
    "可旋开多层机关的腕部钥匙",
    "手腕展开的风暴测绘小仪",
    "鞋底翻转的弹性攀爬片",
    "挂在尾端的折叠方位仪",
    "可变成行军餐盘的随身盖板",
    "带方向测定功能的双节长柄装置",
    "从口袋弹出的三段伸缩挂架"
  ],
  "signature": [
    "左侧轮廓留有旧日碰撞造成的小缺口",
    "肩部两道浅浅的修复痕",
    "一侧齿形结构比另一侧短一截",
    "左右角状结构的长度略有差异",
    "眼周一块与体表纹路呼应的色斑",
    "腰侧明显但整齐的缝合补片",
    "常用把手表面磨得更光滑",
    "右侧握持区保留原材料的不同颜色",
    "一侧眉弧形面板有自然缺口",
    "尾部末端套有旧连接环",
    "外层保护片有一处褪色磨砂层",
    "两侧前肢的体块比例略有差异"
  ],
  "entity": [
    "两个小角色连接后组成同一圆形外轮廓",
    "一大一小通过共用背壳协同行动",
    "主角与悬浮辅助体共享一根牵引带",
    "上半体负责观察，下半体负责移动",
    "两位角色拆开后分别承担导航和防护",
    "三个小单元合并为同一套移动装置",
    "小角色嵌在大角色的圆形保护舱内",
    "主体与镜像助手以反向动作协作",
    "主体与载具共用一个可拆卸轴心",
    "身体正反两面具有不同的操作界面",
    "同一外壳的两个意识交替操纵机关",
    "两位外形呼应的伙伴用互补零件联动"
  ],
  "physique": [
    "肩部体块大，腿部自然收束",
    "厚实下盘与矮短躯干形成稳定底座",
    "细长四肢连接紧凑圆躯",
    "大头部与短直肢形成夸张节奏",
    "上圆下尖的柔和水珠轮廓",
    "上身宽下身窄的稳定三角体块",
    "圆腹是全身最大且连续的主形",
    "层层收束的圆角锥体",
    "一侧肩宽略大但重心平衡",
    "狭长的躯体搭配宽厚接地脚掌",
    "肩部横向展开，脚部紧凑",
    "大球形躯干与短小功能肢体"
  ]
};

export const EN_LABEL = {
  "动物": "Animal",
  "植物": "Plant",
  "日常物品": "Everyday object",
  "自然现象": "Natural phenomenon",
  "职业": "Profession",
  "神话": "Mythology",
  "工业": "Industrial object",
  "建筑": "Architecture",
  "食物": "Food",
  "乐器": "Musical instrument",
  "交通工具": "Vehicle",
  "天文": "Astronomy",
  "远古文明": "Ancient civilization",
  "街头文化": "Street culture",
  "海洋探索": "Ocean exploration",
  "节庆民俗": "Festive folklore",
  "蒸汽科技": "Steam technology",
  "梦境": "Dreamworld",
  "童话": "Fairy tale",
  "美食文化": "Culinary culture",
  "竞技运动": "Sports competition",
  "太空旅行": "Space travel",
  "戏曲": "Chinese opera",
  "深海科研": "Deep-sea science"
};

export const SOURCE_EN = {
  "海獭": "sea otter",
  "蜗牛": "snail",
  "企鹅": "penguin",
  "穿山甲": "pangolin",
  "水豚": "capybara",
  "螃蟹": "crab",
  "蒲公英": "dandelion",
  "仙人掌": "cactus",
  "松果": "pinecone",
  "蘑菇": "mushroom",
  "老式怀表": "vintage pocket watch",
  "折叠雨伞": "folding umbrella",
  "保温壶": "thermos",
  "纸灯笼": "paper lantern",
  "小型积雨云": "tiny raincloud",
  "极光": "aurora",
  "漩涡": "whirlpool",
  "闪电": "lightning bolt",
  "邮差": "postman",
  "修理匠": "mechanic",
  "烘焙师": "baker",
  "园艺师": "gardener",
  "石狮守护灵": "stone lion spirit",
  "小麒麟": "baby qilin",
  "山灵": "mountain spirit",
  "风精灵": "wind spirit",
  "卷线器": "cable reel",
  "齿轮箱": "gearbox",
  "液压千斤顶": "hydraulic jack",
  "磁力起重机": "magnetic crane",
  "灯塔": "lighthouse",
  "风车屋": "windmill cottage",
  "拱桥": "arch bridge",
  "钟楼": "clock tower",
  "牛角面包": "croissant",
  "糯米团": "glutinous rice ball",
  "爆米花": "popcorn",
  "甜甜圈": "doughnut",
  "手风琴": "accordion",
  "小号": "trumpet",
  "木琴": "xylophone",
  "留声机": "gramophone",
  "独轮车": "unicycle",
  "潜水艇": "submarine",
  "热气球": "hot air balloon",
  "复古电车": "vintage tram",
  "小行星": "asteroid",
  "彗星": "comet",
  "土星环": "Saturn-inspired ringed planet",
  "月牙": "crescent moon"
};

export const CONCEPT_EN = {
  "遗迹探路员": "ruin pathfinder",
  "星图考古家": "star-map archaeologist",
  "涂鸦快递员": "graffiti courier",
  "节拍滑行家": "rhythm skater",
  "深海领航员": "deep-sea navigator",
  "潮汐邮差": "tide courier",
  "巡游灯彩师": "processional lantern artisan",
  "鼓点仪仗员": "ceremonial drum guard",
  "蒸汽修补匠": "steam mechanic",
  "发条巡检员": "clockwork inspector",
  "梦境收集员": "dream collector",
  "午夜寻梦者": "midnight dream seeker",
  "森林故事管理员": "forest story curator",
  "魔法邮局学徒": "magic post-office apprentice",
  "风味调配师": "flavor blending specialist",
  "流动甜品师": "traveling pastry chef",
  "反重力球员": "anti-gravity ball player",
  "极限接力手": "extreme relay racer",
  "星际快递员": "interstellar courier",
  "迷你行星导游": "mini-planet guide",
  "戏台机关师": "opera-stage engineer",
  "巡游武生": "processional martial-role opera performer",
  "微光观测员": "faint-light observer",
  "海沟标本师": "trench specimen curator"
};

export const PROP_EN = {
  "石刻罗盘": "stone-engraved compass",
  "可拼接星图": "modular star chart",
  "喷绘式信号徽记": "graffiti signal emblem",
  "折叠滑行板": "folding glide board",
  "发光航海罗盘": "glowing nautical compass",
  "浮力邮包": "buoyant mailbag",
  "层层展开的灯彩": "multi-layer unfolding festival lantern",
  "节奏鼓槌": "rhythm drumsticks",
  "压力刻度盘": "pressure gauge",
  "可上弦密钥": "wind-up key",
  "透明梦泡容器": "transparent dream-bubble capsule",
  "可旋转睡梦星图": "rotating dream star map",
  "会翻页的故事盒": "self-turning story box",
  "封蜡印章": "wax seal stamper",
  "分层调味盘": "tiered seasoning tray",
  "可折叠甜品架": "folding dessert rack",
  "悬浮计分环": "floating score ring",
  "多段接力棒": "segmented relay baton",
  "轨道导航包": "orbital navigation pack",
  "掌上轨道仪": "handheld orbital instrument",
  "可展开的戏台扇": "expanding opera-stage fan",
  "折叠式戏曲靠旗": "folding back-mounted Chinese-opera banners",
  "球形观测探针": "spherical research probe",
  "透明标本仓": "transparent specimen chamber"
};

