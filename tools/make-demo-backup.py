# -*- coding: utf-8 -*-
"""生成格物 App 的演示/测试备份包。

用途：新装机、空库时导入一批「像真的」数据，便于验收
      列表 / 筛选 / 分类 / 位置 / 到期提醒 / 库存 / 回收站 等界面。

产物：格物-测试数据-100条-YYYYMMDD.zip
      包结构完全对齐 src/lib/backup/backup.ts 的 createBackupFile()：
        manifest.json / README.txt
        data/categories.json  data/locations.json
        data/items.json       data/photos.json
      字段名一律用 src/lib/types.ts 的 camelCase（导入端 insertRaw 直接吃）。

导入：App 的「我的 → 导入备份」，选「覆盖」或「追加合并」均可。
      覆盖导入会连内置分类一起清掉，所以本包里**自带全部 14 个内置分类**
      （名称/顺序与 src/lib/suggest.ts 的 BUILTIN_CATEGORIES 完全一致）。

★ 本包不含照片：photos.json 为空数组。
  applyBackup 对「有索引、无文件」的照片不会报错，只会留下死链缩略图；
  宁可一张不带，也不给用户留一堆加载不出来的灰块。

调用：
  python tools/make-demo-backup.py                # 输出到仓库上一级（工作区根）
  python tools/make-demo-backup.py --out D:/x    # 指定输出目录
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import uuid
import zipfile
from datetime import date, timedelta

# ------------------------------------------------------------------ 基础

TODAY = date(2026, 10, 9)          # 与生成时刻无关，固定基准日让数据可复现
BACKUP_FORMAT_VERSION = 1
SCHEMA_VERSION = 3
NS = uuid.UUID('6f7a1c2e-3d4b-4e59-8a10-5b6c7d8e9f01')

NOW = TODAY.toordinal()            # 只用于算「距今天数」，不写进数据


def uid(key: str) -> str:
    """确定性 UUID：同名多次生成结果一致，便于 diff 与复现。"""
    return str(uuid.uuid5(NS, key))


def day(offset: int) -> str:
    """相对基准日的 ISO 日期串，形如 2026-10-09（types.ts 的 DateString）。"""
    return (TODAY + timedelta(days=offset)).isoformat()


UNIX_EPOCH_ORDINAL = date(1970, 1, 1).toordinal()


def millis(offset_days: int, hour: int = 10, minute: int = 0) -> int:
    """相对基准日的毫秒时间戳。

    ★ 必须减去 Unix 纪元序数：`toordinal()` 从公元 1 年起算，
      直接用它会得到 ~6.4e13（约公元 4000 年）—— 排序不受影响、
      界面上的「录入时间」却是错的，属于不报错的那类故障。
    """
    d = TODAY + timedelta(days=offset_days)
    dt = date(d.year, d.month, d.day)
    return ((dt.toordinal() - UNIX_EPOCH_ORDINAL) * 86400 + hour * 3600 + minute * 60) * 1000


# ------------------------------------------------------------------ 分类

# 顺序即 sort_order（显示顺序）。前 14 个是内置分类，顺序必须与
# src/lib/suggest.ts 的 BUILTIN_CATEGORIES 一致；后 3 个是自建分类。
CATEGORIES = [
    ('数码', None, True),
    ('工具', None, True),
    ('五金', None, True),
    ('药品', 24, True),
    ('食品', 12, True),
    ('个护', 24, True),
    ('清洁', 24, True),
    ('厨房', None, True),
    ('家居', None, True),
    ('服饰', None, True),
    ('文具', None, True),
    ('运动户外', None, True),
    ('图书', None, True),
    ('宠物', 12, True),
    ('园艺', None, False),
    ('手工', None, False),
    ('耗材', None, False),
]

# ------------------------------------------------------------------ 位置

# 两级结构：柜子（parentId 为空）→ 格位
# 格位数按「这个柜子该放多少东西」定，让每格落到 2~6 件，不至于一半空着
LOCATIONS = [
    ('玄关柜', ['上层收纳', '抽屉', '鞋柜下层']),
    ('客厅电视柜', ['左侧格', '右侧格', '下层抽屉']),
    ('厨房吊柜', ['上层', '中层', '下层']),
    ('阳台储物柜', ['左格', '中格', '右格']),
    ('卧室衣柜', ['挂衣区', '顶层收纳', '抽屉']),
    ('书房书架', ['第一层', '第二层', '第三层', '第四层']),
    ('卫生间镜柜', ['上层', '中层', '下层']),
    ('储物间货架', ['A 层', 'B 层', 'C 层', 'D 层', 'E 层']),
]

SLOT_NAMES = dict(LOCATIONS)

# 分类 → 常用柜子（决定物品「放哪儿」，同一柜子内再按格位轮转）
CAT_LOC = {
    '数码': '客厅电视柜',
    '工具': '储物间货架',
    '五金': '储物间货架',
    '药品': '卫生间镜柜',
    '食品': '厨房吊柜',
    '个护': '卫生间镜柜',
    '清洁': '阳台储物柜',
    '厨房': '厨房吊柜',
    '家居': '玄关柜',
    '服饰': '卧室衣柜',
    '文具': '书房书架',
    '运动户外': '阳台储物柜',
    '图书': '书房书架',
    '宠物': '储物间货架',
    '园艺': '阳台储物柜',
    '手工': '储物间货架',
    '耗材': '储物间货架',
    None: '玄关柜',
}

# ------------------------------------------------------------------ 物品

# (名称, 分类, 品牌, 型号, 价格, 数量, 标签, 备注, 到期档, 购买距今天数)
#   到期档：'o' 已过期 / 's' 30 天内到期 / 'f' 还早 / None 无保质期
#   数量 None = 单件物品（不启用库存）
T = [
    # ---- 数码 8
    ('iPhone 15 Pro', '数码', 'Apple', 'A2848', 7999.00, None, ['常用', '主力机'],
     '256G 原色钛金属，2025 年换过一次电池', None, 574),
    ('MacBook Air M3 13 英寸', '数码', 'Apple', 'A3113', 8999.00, None, ['常用'],
     '16G+512G，配 MagSafe 充电线', None, 480),
    ('索尼 WH-1000XM5 头戴耳机', '数码', '索尼', 'WH-1000XM5', 2199.00, None, ['常用'],
     '收纳盒在同一个抽屉', None, 400),
    ('罗技 MX Master 3S 鼠标', '数码', '罗技', 'MX Master 3S', 699.00, None, [],
     None, None, 300),
    ('Anker 65W 氮化镓充电器', '数码', 'Anker', 'A2666', 149.00, None, ['备用'],
     '出差带的小充电头', None, 260),
    ('三星 T7 移动固态硬盘 1TB', '数码', '三星', 'MU-PC1T0T', 599.00, None, [],
     '放着以前的照片备份', None, 700),
    ('Type-C 编织数据线 2m', '数码', '绿联', 'CD137', 39.90, 4, ['囤货'],
     '一次买了 5 根，用掉一根', None, 150),
    ('小米移动电源 20000mAh', '数码', '小米', 'PLM18ZM', 129.00, None, [],
     '电池鼓包过一次，换新了', 'o', None),

    # ---- 工具 6
    ('博世 12V 充电电钻', '工具', '博世', 'GSR 120-LI', 499.00, None, [],
     '附 2.0Ah 电池两块、批头一套', None, 820),
    ('米家 精修螺丝刀套装', '工具', '米家', 'MJDDZSQ01QW', 99.00, None, ['常用'],
     '拆手机用，24 个批头', None, 200),
    ('史丹利 5m 钢卷尺', '工具', '史丹利', 'STHT33030', 45.00, None, [],
     None, None, 640),
    ('得力 羊角锤', '工具', '得力', 'DL5002', 32.00, None, [],
     None, None, 900),
    ('绿林 内六角扳手组', '工具', '绿林', '09101', 42.00, None, [],
     '公制 1.5-10mm', None, 510),
    ('优利德 数字万用表', '工具', '优利德', 'UT136B+', 129.00, None, [],
     None, None, 380),

    # ---- 五金 6
    ('304 不锈钢自攻螺丝 M4×20', '五金', None, '100 颗/盒', 15.80, 3, ['囤货'],
     '装家具剩的，整盒没拆', None, 430),
    ('免钉胶膨胀螺栓套装', '五金', None, '20 套', 22.00, None, [],
     '挂画用的', 's', None),
    ('不锈钢合页 4 寸', '五金', '海蒂诗', '2 只装', 36.00, None, [],
     None, None, 700),
    ('尼龙扎带 4×200mm', '五金', None, '500 根/包', 12.50, 2, ['囤货'],
     None, None, 360),
    ('3M 强力双面胶 2cm×3m', '五金', '3M', 'VHB', 28.00, None, [],
     '胶应该快硬了', 'o', None),
    ('滚珠万向轮 2 寸', '五金', None, '4 只装', 26.00, None, [],
     '本来想给收纳箱装轮子', None, 250),

    # ---- 药品 6
    ('布洛芬缓释胶囊', '药品', '芬必得', '0.3g×20 粒', 25.00, None, ['常备'],
     '放上层，别和零食混', 'f', None),
    ('连花清瘟胶囊', '药品', '以岭', '24 粒/盒', 23.00, None, [],
     None, 'o', None),
    ('云南白药创可贴 100 片', '药品', '云南白药', '100 片装', 19.90, None, ['常备'],
     None, 'f', None),
    ('蒙脱石散', '药品', '思密达', '3g×10 袋', 26.00, None, [],
     '上次肠胃炎剩下的', 'o', None),
    ('维生素 D3 软胶囊', '药品', '汤臣倍健', '60 粒', 89.00, None, ['常备'],
     '每天一粒', 'f', None),
    ('医用外科口罩 50 只', '药品', '稳健', None, 29.90, 3, ['囤货'],
     None, 's', None),

    # ---- 食品 8
    ('伊利 金典纯牛奶 250ml×12', '食品', '伊利', None, 68.00, None, ['消耗品'],
     None, 's', None),
    ('十月稻田 五常大米 5kg', '食品', '十月稻田', None, 89.90, None, ['主食'],
     None, 's', None),
    ('金龙鱼 玉米油 5L', '食品', '金龙鱼', None, 79.90, None, ['主食'],
     None, 'f', None),
    ('三顿半 精品速溶咖啡 24 颗', '食品', '三顿半', None, 199.00, None, ['常用'],
     '小罐装，办公室带几颗', 'f', None),
    ('康师傅 红烧牛肉面 5 连包', '食品', '康师傅', None, 22.50, 2, ['零食'],
     '加班备用', 'o', None),
    ('好想你 每日坚果 30 包', '食品', '好想你', None, 89.00, None, ['零食'],
     '买回来就忘了', 'o', None),
    ('海天 金标生抽 1.9L', '食品', '海天', None, 26.90, None, ['调味'],
     None, 'f', None),
    ('光明 莫斯利安酸奶 12 盒', '食品', '光明', None, 59.90, None, ['消耗品'],
     '开封后尽快喝', 'o', None),

    # ---- 个护 7
    ('舒肤佳 沐浴露 1L', '个护', '舒肤佳', None, 45.90, None, ['消耗品'],
     None, 'f', None),
    ('云南白药 牙膏 150g', '个护', '云南白药', None, 26.80, None, ['消耗品'],
     None, 'f', None),
    ('海飞丝 去屑洗发水 750ml', '个护', '海飞丝', None, 69.90, None, ['消耗品'],
     None, 's', None),
    ('安耐晒 小金瓶防晒霜 60ml', '个护', '安耐晒', None, 218.00, None, ['季节'],
     '夏天用，冬天收起来', 'f', None),
    ('飞利浦 电动牙刷头 HX6013', '个护', '飞利浦', 'HX6013', 129.00, 4, ['囤货'],
     '四支装', None, 280),
    ('全棉时代 洗脸巾 3 卷', '个护', '全棉时代', None, 59.00, 1, ['囤货'],
     None, 'f', None),
    ('高露洁 漱口水 500ml', '个护', '高露洁', None, 32.00, None, [],
     None, 'o', None),

    # ---- 清洁 6
    ('蓝月亮 深层洁净洗衣液 3kg', '清洁', '蓝月亮', None, 49.90, 0, ['消耗品'],
     '空瓶还没扔', None, 320),
    ('威猛先生 洁厕灵 500g×2', '清洁', '威猛先生', None, 26.00, None, ['消耗品'],
     None, 'f', None),
    ('3M 思高 静电除尘拖把', '清洁', '3M', None, 89.00, None, [],
     '替换纸没了要补', None, 460),
    ('花王 厨房油污清洁剂', '清洁', '花王', None, 39.00, None, [],
     None, 's', None),
    ('妙洁 抽取式垃圾袋 45×55', '清洁', '妙洁', None, 19.90, 3, ['囤货'],
     '100 只装', None, 210),
    ('茶花 扫把簸箕套装', '清洁', '茶花', None, 59.00, None, [],
     None, None, 560),

    # ---- 厨房 7
    ('苏泊尔 不粘炒锅 30cm', '厨房', '苏泊尔', None, 259.00, None, ['常用'],
     '麦饭石涂层，别用铁铲', None, 630),
    ('双立人 陶瓷刀', '厨房', '双立人', None, 299.00, None, [],
     '切水果专用', None, 350),
    ('膳魔师 保温杯 500ml', '厨房', '膳魔师', 'JNL-502', 259.00, None, ['常用'],
     None, None, 290),
    ('摩飞 便携榨汁杯', '厨房', '摩飞', 'MR9800', 259.00, None, [],
     '电池不耐用了', None, 780),
    ('乐扣乐扣 玻璃保鲜盒 4 件套', '厨房', '乐扣乐扣', None, 89.00, None, [],
     '带饭用', None, 240),
    ('海天 蚝油 700g', '厨房', '海天', None, 18.90, None, ['调味'],
     None, 'f', None),
    ('张小泉 厨房剪刀', '厨房', '张小泉', None, 39.00, None, ['常用'],
     None, None, 190),

    # ---- 家居 4
    ('网易严选 记忆棉护颈枕', '家居', '网易严选', None, 129.00, None, ['常用'],
     None, None, 520),
    ('京东京造 折叠收纳箱 66L', '家居', '京东京造', None, 49.00, 3, ['收纳'],
     '三个叠着放', None, 170),
    ('松下 LED 护眼台灯', '家居', '松下', 'HHLT0623', 299.00, None, ['常用'],
     '书桌那盏', None, 610),
    ('米家 智能加湿器 2', '家居', '米家', 'CJJSQ02XY', 249.00, None, [],
     '冬天才用', None, 720),

    # ---- 服饰 7
    ('优衣库 摇粒绒外套 男 L', '服饰', '优衣库', '459889', 199.00, None, ['常用'],
     '冬天穿，挂最里面', None, 700),
    ('优衣库 法兰绒格纹衬衫', '服饰', '优衣库', None, 149.00, None, [],
     None, None, 380),
    ('迪卡侬 徒步越野跑鞋 42 码', '服饰', '迪卡侬', None, 249.00, None, ['户外'],
     '鞋底磨得差不多了', None, 530),
    ('南极人 加厚棉袜 10 双装', '服饰', '南极人', None, 39.90, 1, ['囤货'],
     '拆过一双', None, 260),
    ('骆驼 三合一冲锋衣', '服饰', '骆驼', None, 499.00, None, ['户外'],
     '内胆能拆', None, 460),
    ('无印良品 针织毛线帽', '服饰', '无印良品', None, 79.00, None, [],
     None, None, 590),
    ('小米 偏光太阳镜', '服饰', '小米', None, 99.00, None, ['季节'],
     None, None, 330),

    # ---- 文具 6
    ('斑马 中性笔 JJ15 黑色 10 支', '文具', '斑马', 'JJ15', 68.00, 3, ['囤货'],
     None, None, 330),
    ('国誉 Campus 笔记本 B5', '文具', '国誉', None, 15.00, 4, ['囤货'],
     '点阵内页', None, 270),
    ('惠普 打印机墨盒 805 黑色', '文具', '惠普', 'HP 805', 89.00, None, [],
     None, 'f', None),
    ('得力 订书机 + 订书钉', '文具', '得力', '0390', 32.00, None, [],
     None, None, 400),
    ('3M 便签纸 76×76 5 本', '文具', '3M', '654', 18.00, None, [],
     None, None, 310),
    ('辉柏嘉 自动铅笔 0.5', '文具', '辉柏嘉', None, 12.00, None, [],
     None, None, 220),

    # ---- 运动户外 6
    ('迪卡侬 20L 轻量登山包', '运动户外', '迪卡侬', 'MH500', 199.00, None, ['户外'],
     None, None, 500),
    ('李宁 5 号篮球', '运动户外', '李宁', None, 129.00, None, [],
     '气有点不足', None, 690),
    ('Keep 瑜伽垫 183×61', '运动户外', 'Keep', None, 89.00, None, ['常用'],
     None, None, 430),
    ('迪卡侬 钢丝竞速跳绳', '运动户外', '迪卡侬', None, 39.90, None, [],
     None, None, 160),
    ('迪卡侬 骑行头盔', '运动户外', '迪卡侬', None, 149.00, None, ['户外'],
     'M 码', None, 480),
    ('骆驼 自动充气帐篷 2 人', '运动户外', '骆驼', None, 399.00, None, ['户外'],
     '一直没拆封', None, 800),

    # ---- 图书 5
    ('《人类简史》', '图书', '中信出版社', None, 68.00, None, [],
     '读到一半', None, 940),
    ('《代码整洁之道》', '图书', '人民邮电出版社', None, 89.00, None, [],
     '封面有点卷边', None, 860),
    ('《置身事内：中国政府与经济发展》', '图书', '上海人民出版社', None, 65.00, None, [],
     '借给同事了，备注一下', None, 420),
    ('《三体》全集 3 册', '图书', '重庆出版社', None, 95.00, None, [],
     '买了两次，这套多的', None, 380),
    ('《中国国家地理》2026 年合订本', '图书', None, None, 120.00, None, [],
     None, None, 140),

    # ---- 宠物 5
    ('皇家 室内成猫粮 2kg', '宠物', '皇家', None, 189.00, None, ['消耗品'],
     '密封桶装着的', 'o', None),
    ('洁客 豆腐猫砂 6L', '宠物', '洁客', None, 29.90, 0, ['消耗品'],
     '用完了，得买', None, 130),
    ('拜耳 猫用驱虫药', '宠物', '拜耳', None, 158.00, None, [],
     '三个月一次', 'f', None),
    ('逗猫棒套装', '宠物', None, None, 25.00, None, [],
     '羽毛的已经咬秃了', None, 230),
    ('小佩 宠物指甲剪', '宠物', '小佩', None, 39.00, None, [],
     None, None, 360),

    # ---- 园艺 4
    ('绿萝盆栽 中号', '园艺', None, None, 39.00, None, [],
     '放阳台，两周浇一次', None, 410),
    ('花彩师 多肉营养土 5L', '园艺', '花彩师', None, 22.00, 2, [],
     None, None, 290),
    ('张小泉 园艺修枝剪', '园艺', '张小泉', None, 45.00, None, [],
     None, None, 340),
    ('有机肥颗粒 1kg', '园艺', None, None, 18.00, None, [],
     None, 'f', None),

    # ---- 手工 3
    ('得力 热熔胶枪 + 胶棒 20 根', '手工', '得力', None, 45.00, 2, [],
     '胶棒放久了会失效', 's', None),
    ('羊毛毡材料包', '手工', None, None, 68.00, None, [],
     '做了一半的柴犬', None, 180),
    ('家用针线盒套装', '手工', None, None, 29.00, None, [],
     None, None, 620),

    # ---- 耗材 3
    ('小米 空气净化器滤芯', '耗材', '小米', None, 199.00, 1, ['囤货'],
     '换下来的还没扔', None, 200),
    ('得力 A4 打印纸 500 张×5 包', '耗材', '得力', None, 105.00, 1, ['囤货'],
     None, None, 120),
    ('米家 扫地机 边刷', '耗材', '米家', None, 39.00, 6, ['囤货'],
     '一次买了一盒', None, 90),

    # ---- 未分类 3（分类为 null，用来验收「未分类」入口）
    ('备用防盗门钥匙', None, None, None, None, None, ['备用'],
     '从旧房子带过来的', None, None),
    ('旧款 Lightning 数据线', None, None, None, None, None, [],
     '不知道是谁的，先留着', None, None),
    ('快递拆下的气泡膜', None, None, None, None, None, [],
     '留着以后寄东西用', None, None),
]

# 手动排序：带「常用」标签的前 10 件给 sortOrder 1..10（其余为 null，沉底）
MANUAL_SORT_NAMES = [
    'iPhone 15 Pro', 'MacBook Air M3 13 英寸', '索尼 WH-1000XM5 头戴耳机',
    '米家 精修螺丝刀套装', '三顿半 精品速溶咖啡 24 颗', '苏泊尔 不粘炒锅 30cm',
    '膳魔师 保温杯 500ml', '张小泉 厨房剪刀', '松下 LED 护眼台灯',
    'Keep 瑜伽垫 183×61',
]

# 回收站（deletedAt 非空）：验收「回收站 / 恢复 / 彻底删除」
TRASHED_NAMES = [
    '旧款 Lightning 数据线',
    '《三体》全集 3 册',
    '京东京造 折叠收纳箱 66L',
    '3M 便签纸 76×76 5 本',
]

# 不指定位置（locationId = null）：验收「未放位置」这一档
NO_LOCATION_NAMES = [
    '快递拆下的气泡膜',
    '旧款 Lightning 数据线',
    '惠普 打印机墨盒 805 黑色',
    '绿萝盆栽 中号',
    '米家 扫地机 边刷',
]

# 无购买日期（purchaseDate = null）：让「持有天数 / 日均成本」有空档
NO_PURCHASE = {
    '小米移动电源 20000mAh', '免钉胶膨胀螺栓套装', '3M 强力双面胶 2cm×3m',
    '布洛芬缓释胶囊', '连花清瘟胶囊', '云南白药创可贴 100 片', '蒙脱石散',
    '维生素 D3 软胶囊', '医用外科口罩 50 只',
    '伊利 金典纯牛奶 250ml×12', '十月稻田 五常大米 5kg', '金龙鱼 玉米油 5L',
    '康师傅 红烧牛肉面 5 连包', '好想你 每日坚果 30 包', '海天 金标生抽 1.9L',
    '光明 莫斯利安酸奶 12 盒',
    '舒肤佳 沐浴露 1L', '云南白药 牙膏 150g', '海飞丝 去屑洗发水 750ml',
    '安耐晒 小金瓶防晒霜 60ml', '高露洁 漱口水 500ml',
    '蓝月亮 深层洁净洗衣液 3kg', '威猛先生 洁厕灵 500g×2',
    '花王 厨房油污清洁剂', '海天 蚝油 700g',
    '皇家 室内成猫粮 2kg', '拜耳 猫用驱虫药', '有机肥颗粒 1kg',
    '得力 热熔胶枪 + 胶棒 20 根',
    '备用防盗门钥匙', '旧款 Lightning 数据线', '快递拆下的气泡膜',
}

# 到期档 → (过期日偏移区间)
EXP_WINDOW = {
    'o': (-150, -3),      # 已过期
    's': (1, 28),         # 30 天内到期
    'f': (45, 800),       # 还早
}

# 分类 → 保质期月数（用来反推「购买日期」应早于到期日多久）
SHELF_DAYS = {
    '药品': 730, '食品': 365, '个护': 730, '清洁': 900, '宠物': 540,
    '数码': 1095, '文具': 1095, '厨房': 730, '五金': 1095, '园艺': 730,
    '手工': 730, '家居': 1095,
}


def build():
    # ---------------- 分类
    categories = []
    cat_id = {}
    for order, (name, months, builtin) in enumerate(CATEGORIES):
        cid = uid(f'cat:{name}')
        cat_id[name] = cid
        categories.append({
            'id': cid,
            'name': name,
            'parentId': None,
            'defaultExpireMonths': months,
            'sortOrder': order,
            'builtin': builtin,
        })

    # ---------------- 位置
    locations = []
    slot_ids = {}          # 柜子名 -> [格位 id]
    loc_id = {}            # (柜子名, 格位名) -> id
    order = 0
    for cab, slots in LOCATIONS:
        cab_id = uid(f'loc:{cab}')
        locations.append({
            'id': cab_id, 'name': cab, 'parentId': None,
            'note': None, 'builtin': False, 'sortOrder': order,
        })
        order += 1
        slot_ids[cab] = []
        for s in slots:
            sid = uid(f'loc:{cab}/{s}')
            slot_ids[cab].append(sid)
            loc_id[(cab, s)] = sid
            locations.append({
                'id': sid, 'name': s, 'parentId': cab_id,
                'note': None, 'builtin': False, 'sortOrder': order,
            })
            order += 1

    # ---------------- 物品
    assert len(T) == 100, f'物品数应为 100，实际 {len(T)}'

    # 同一柜子内的格位轮转指针
    cursor = {cab: 0 for cab in slot_ids}
    items = []
    for idx, (name, cat, brand, model, price, qty, tags, note, exp, pur) in enumerate(T):
        # 到期日与购买日
        expire = None
        if exp:
            lo, hi = EXP_WINDOW[exp]
            # 用索引做确定性抖动，避免所有日期挤在一起
            span = hi - lo
            off = lo + (idx * 17 + 11) % (span + 1)
            expire = day(off)
        purchase = None
        if name not in NO_PURCHASE:
            if exp:
                shelf = SHELF_DAYS.get(cat or '', 730)
                shelf += ((idx * 13) % 61) - 30
                # 购买日必须落在过去：先减去保质期，再夹到「至少 10 天前」，
                # 否则保质期长的东西（如 5L 油）会算出未来的购买日期
                d = (TODAY + timedelta(days=off)).toordinal() - shelf
                cap = TODAY.toordinal() - (10 + (idx * 7) % 400)
                purchase = date.fromordinal(min(d, cap)).isoformat()
            elif pur is not None:
                purchase = day(-pur)

        # 位置
        if name in NO_LOCATION_NAMES:
            location = None
        else:
            cab = CAT_LOC.get(cat)          # 键含 None，未分类落到玄关柜
            if cab is None:
                location = None
            else:
                slots_of = SLOT_NAMES[cab]
                location = slot_ids[cab][cursor[cab] % len(slots_of)]
                cursor[cab] += 1

        # 时间戳：录入时间铺开在近 2.5 年，最后编辑时间晚于录入
        created_off = -int(8 + (idx * 8.9) % 900)
        # 37 与 8.9 互质，能铺开「最近编辑」的分布（有些东西一年没动过）
        updated_off = created_off + int((idx * 37) % max(1, -created_off - 1))
        if updated_off > -1:
            updated_off = -1
        deleted = None
        if name in TRASHED_NAMES:
            deleted = millis(created_off + 60, 9, 30)

        items.append({
            'id': uid(f'item:{idx}:{name}'),
            'name': name,
            'categoryId': cat_id.get(cat) if cat else None,
            'locationId': location,
            'purchaseDate': purchase,
            'price': price,
            'expireDate': expire,
            'brand': brand,
            'model': model,
            'quantity': qty,
            'tags': tags,
            'note': note,
            'sortOrder': (MANUAL_SORT_NAMES.index(name) + 1) if name in MANUAL_SORT_NAMES else None,
            'createdAt': millis(created_off, 9 + (idx % 9), (idx * 7) % 60),
            'updatedAt': millis(updated_off, 9 + (idx % 9), (idx * 11) % 60),
            'deletedAt': deleted,
        })

    manifest = {
        'app': 'gewu',
        'appName': '格物',
        'formatVersion': BACKUP_FORMAT_VERSION,
        'schemaVersion': SCHEMA_VERSION,
        'createdAt': millis(0, 14, 30),
        'counts': {
            'items': len(items),
            'categories': len(categories),
            'locations': len(locations),
            'photos': 0,
        },
    }

    readme = '\n'.join([
        '格物 · 测试数据包',
        '',
        f'物品 {len(items)} 件 / 分类 {len(categories)} 个 / 位置 {len(locations)} 处',
        '',
        '这是为验收界面准备的演示数据，不是真实物品记录。',
        '导入方式：我的 → 导入备份 → 选中本文件 → 覆盖导入。',
        '',
        '包内数据：',
        f'  data/items.json       {len(items)} 件物品'
        f'（含 {sum(1 for i in items if i["deletedAt"])} 件在回收站、'
        f'{sum(1 for i in items if i["categoryId"] is None)} 件未分类、'
        f'{sum(1 for i in items if i["locationId"] is None)} 件未指定位置）',
        '  data/categories.json  14 个内置分类 + 3 个自建分类',
        f'  data/locations.json   {len([l for l in locations if l["parentId"] is None])} 个柜子 +'
        f' {len([l for l in locations if l["parentId"]])} 个格位',
        '  data/photos.json      空（本包不含照片）',
    ])

    return manifest, readme, categories, locations, items


# ------------------------------------------------------------------ 落盘前的自检

DDL = """
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, parent_id TEXT,
  default_expire_months INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE locations (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, parent_id TEXT, note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category_id TEXT, location_id TEXT,
  purchase_date TEXT, price REAL, expire_date TEXT, brand TEXT, model TEXT,
  quantity INTEGER, tags TEXT NOT NULL DEFAULT '[]', note TEXT, sort_order INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE photos (
  id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, file_path TEXT NOT NULL,
  thumb_path TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
"""


def verify(categories, locations, items):
    """按 App 的建表 DDL 与 INSERT 语义，把数据真灌进一次 SQLite 再核对。

    这一步能挡住「字段名写错 / 类型写错 / 外键指空」这类只在导入时才炸的问题。
    """
    db = sqlite3.connect(':memory:')
    db.executescript(DDL)
    for c in categories:
        db.execute('INSERT INTO categories (id,name,parent_id,default_expire_months,sort_order,builtin)'
                   ' VALUES (?,?,?,?,?,?)',
                   (c['id'], c['name'], c['parentId'], c['defaultExpireMonths'],
                    c['sortOrder'], 1 if c['builtin'] else 0))
    for l in locations:
        db.execute('INSERT INTO locations (id,name,parent_id,note,sort_order,builtin) VALUES (?,?,?,?,?,?)',
                   (l['id'], l['name'], l['parentId'], l['note'], l['sortOrder'], 1 if l['builtin'] else 0))
    for i in items:
        db.execute('INSERT INTO items (id,name,category_id,location_id,purchase_date,price,'
                   'expire_date,brand,model,quantity,tags,note,sort_order,created_at,updated_at,deleted_at)'
                   ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (i['id'], i['name'], i['categoryId'], i['locationId'], i['purchaseDate'],
                    i['price'], i['expireDate'], i['brand'], i['model'], i['quantity'],
                    json.dumps(i['tags'], ensure_ascii=False), i['note'], i['sortOrder'],
                    i['createdAt'], i['updatedAt'], i['deletedAt']))
    db.commit()

    on = TODAY.isoformat()
    q = lambda sql, *a: db.execute(sql, a).fetchone()[0]

    ids = {c['id'] for c in categories}
    locs = {l['id'] for l in locations}
    lo = 1704038400000          # 2024-01-01 00:00 UTC
    hi = 1791561600000          # 2026-10-10 00:00 UTC
    for i in items:
        assert lo <= i['createdAt'] <= hi, f"录入时间戳越界: {i['name']} {i['createdAt']}"
        assert lo <= i['updatedAt'] <= hi, f"编辑时间戳越界: {i['name']} {i['updatedAt']}"
        assert i['categoryId'] is None or i['categoryId'] in ids, f"分类外键失效: {i['name']}"
        assert i['locationId'] is None or i['locationId'] in locs, f"位置外键失效: {i['name']}"
        assert i['deletedAt'] is None or i['deletedAt'] >= i['createdAt'], f"删除时间早于录入: {i['name']}"
        assert i['updatedAt'] >= i['createdAt'], f"编辑时间早于录入: {i['name']}"
        assert i['quantity'] is None or i['quantity'] >= 0
        if i['purchaseDate'] and i['expireDate']:
            assert i['purchaseDate'] < i['expireDate'], f"购买日期晚于到期日: {i['name']}"
        if i['purchaseDate']:
            assert i['purchaseDate'] <= on, f"购买日期在未来: {i['name']}"

    total = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL')
    overdue = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND expire_date IS NOT NULL'
                ' AND julianday(expire_date)-julianday(?) < 0', on)
    soon = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND expire_date IS NOT NULL'
             ' AND julianday(expire_date)-julianday(?) >= 0 AND julianday(expire_date)-julianday(?) <= 30', on, on)
    expiring = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND expire_date IS NOT NULL'
                 ' AND expire_date <> \'\' AND julianday(expire_date)-julianday(?) <= 30', on)
    low = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND quantity IS NOT NULL AND quantity <= 1')
    attention = q('SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND ('
                  ' (expire_date IS NOT NULL AND expire_date <> \'\' AND julianday(expire_date)-julianday(?) <= 30)'
                  ' OR (quantity IS NOT NULL AND quantity <= 1))', on)
    value = q('SELECT SUM(price) FROM items WHERE deleted_at IS NULL AND price IS NOT NULL')

    rows = db.execute('SELECT category_id, COUNT(*) FROM items WHERE deleted_at IS NULL'
                      ' GROUP BY category_id ORDER BY COUNT(*) DESC').fetchall()
    cat_names = {c['id']: c['name'] for c in categories}
    dist = [(cat_names.get(r[0], '未分类'), r[1]) for r in rows]

    loc_names = {l['id']: l['name'] for l in locations}
    lrows = db.execute('SELECT location_id, COUNT(*) FROM items WHERE deleted_at IS NULL'
                       ' GROUP BY location_id ORDER BY location_id').fetchall()
    used = [(loc_names.get(r[0], '未指定位置'), r[1]) for r in lrows]
    # 柜子本身不直接挂物品（物品挂在格位上），所以空置率只看格位
    slot_total = len([l for l in locations if l['parentId']])
    slot_used = len([r for r in lrows if r[0] is not None])
    empty_slots = slot_total - slot_used

    print(f'  物品（有效）      {total}    回收站 {len(items) - total}')
    print(f'  分类分布          {len(dist)} 档：' + '、'.join(f'{n}{c}' for n, c in dist))
    print(f'  位置分布          {len(used)} 处（含未指定）：' + '、'.join(f'{n}{c}' for n, c in used))
    print(f'  空置格位          {empty_slots} / {slot_total}')
    print(f'  到期：已过期 {overdue} / 30 天内 {soon} / 即将到期口径 {expiring}')
    print(f'  库存：该补货 {low}，待办口径（去重）{attention}')
    print(f'  价格合计          ¥{value:,.2f}')
    print(f'  未分类 {q("SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND category_id IS NULL")}'
          f' / 未指定位置 {q("SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND location_id IS NULL")}'
          f' / 无购买日期 {q("SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND purchase_date IS NULL")}')
    print(f'  照片引用          {q("SELECT COUNT(*) FROM photos")}')
    db.close()


# ------------------------------------------------------------------ 打包

def write_zip(path, manifest, readme, categories, locations, items):
    def blob(obj):
        return json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')

    entries = {
        'manifest.json': blob(manifest),
        'README.txt': readme.encode('utf-8'),
        'data/categories.json': blob(categories),
        'data/locations.json': blob(locations),
        'data/items.json': blob(items),
        'data/photos.json': blob([]),
    }
    # STORE（不压缩）：与 App 的 createBackupFile 一致
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')),
                    help='输出目录（默认写到仓库上一级的工作区根）')
    args = ap.parse_args()

    manifest, readme, categories, locations, items = build()
    print('[1/3] 数据已生成，开始自检 …')
    verify(categories, locations, items)

    name = f'格物-测试数据-100条-{TODAY.strftime("%Y%m%d")}.zip'
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, name)
    size = write_zip(path, manifest, readme, categories, locations, items)
    print(f'[2/3] 已打包 {size / 1024:.1f} KB')
    print(f'[3/3] {path}')


if __name__ == '__main__':
    main()
