/**
 * 格物 · 海报画布
 *
 * 一块固定 360 × 450 dp 的画布（4:5，导出 1080 × 1350）。所有模板共用这一个窗口，
 * 只有「摆法」不同 —— 版式参数全部来自 `lib/share/templates.ts`，这里不许再散落色值。
 *
 * ── 三条渲染规矩 ───────────────────────────────────────────────
 * ★★ 这里**不读 Palette**。海报是「发出去的作品」，不是当前皮肤的界面。
 *   用户换了皮肤，去年发的那张不该跟着变样，否则「我的格物」不成系列。
 *   唯一的接口是 `accent` —— 调用方可以把它换成当前皮肤的 brand，做一点归属感。
 * ★★ 字号一律相对 360 宽写死，不做等比缩放。抓图时 view-shot 会在 canvas 上
 *   等比重绘到 1080，文字是矢量清晰的（见 capture.ts 的注释）。
 * ★ Android 上 `Fonts.serif`（即 `serif`）**可能没有中文字形**，会回落到系统黑体。
 *   模板因此不能只靠衬线撑气质：字距、留白、分隔线必须在黑体下也成立。
 *   要不要打包思源宋体子集，等真机量过再定（见交付说明）。
 */

import { Image } from 'expo-image';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

import { Fonts } from '@/constants/theme';
import { absoluteUri } from '@/lib/photos/pipeline';
import { initialOf } from '@/lib/format';
import { GRID_METRICS, gridMetrics, type PosterCell, type PosterModel } from '@/lib/share/model';
import type { PosterSkin } from '@/lib/share/templates';

const SERIF = Fonts.serif;
const SANS = Fonts.sans;

/* 陈列模板的缺图底色与首字色。取的是海报纸色那一族，不走 skin：
   四套模板共用同一个「没有照片」的观感，换皮时不该跟着变。 */
const CELL_BG = '#F2EDE5'; // theme-color-ok
const CELL_INK = '#C9BEB0'; // theme-color-ok

/* 暗房的压角渐变与编号小字。深色皮只有这一套，值写在这里比塞进 skin 更省事；
   换肤与它无关，所以同样不取 theme.ts。 */
const SHADE_INK = 'rgba(10,8,6,0.10)'; // theme-color-ok
const FULL_INK = 'rgba(246,239,228,0.42)'; // theme-color-ok

export interface PosterProps {
  model: PosterModel;
  skin: PosterSkin;
  /** 覆盖点缀色（默认用 skin 自带）。传 null 表示不覆盖 */
  accent?: string | null;
  /** 每张照片加载完（成功或失败）都会调用一次，供页面等待落图 */
  onPhotoSettled?: () => void;
}

export function Poster({ model, skin, accent, onPhotoSettled }: PosterProps) {
  const a = accent ?? skin.accent;
  if (skin.layout === 'grid') return <GridPoster model={model} skin={skin} accent={a} onSettled={onPhotoSettled} />;
  if (skin.layout === 'stat') return <StatPoster model={model} skin={skin} accent={a} />;
  if (skin.photoMode === 'full') return <FullPoster model={model} skin={skin} onSettled={onPhotoSettled} />;
  return <PlainPoster model={model} skin={skin} accent={a} />;
}

/* ------------------------------------------------------------ 共用件 */

/**
 * 落款。
 *
 * 不是装饰 —— 抓图之后没法再附一段文案，出处只能写在图里。
 * 这也是唯一一处品牌露出，位置固定在右下，字号小到不抢戏。
 */
function Signature({ skin, date, right }: { skin: PosterSkin; date: string; right?: string | null }) {
  const font = skin.metaFont === 'serif' ? SERIF : SANS;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <TextLike font={font} size={8} color={skin.ink3} spacing={1.4}>
        {right ?? `格物 · 收纳柜`}
      </TextLike>
      <TextLike font={font} size={8} color={skin.ink3} spacing={1.4}>
        {date}
      </TextLike>
    </View>
  );
}

/** 统一的小字外壳：RN 的 Text 每处都要重复写 fontFamily / letterSpacing，容易漏 */
function TextLike({
  children,
  font,
  size,
  color,
  spacing = 0,
  lineHeight,
  weight,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  font: string;
  size: number;
  color: string;
  spacing?: number;
  lineHeight?: number;
  weight?: '400' | '500' | '600';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: font,
          fontSize: size,
          lineHeight: lineHeight ?? Math.round(size * 1.45),
          color,
          letterSpacing: spacing,
          fontWeight: weight ?? '400',
        },
        style,
      ]}>
      {children}
    </Text>
  );
}

/** 照片或首字占位。缺图绝不显示破图，与列表缩略图同一条原则 */
function PhotoBox({
  cell,
  size,
  radius,
  bg,
  ink,
  onSettled,
  style,
}: {
  cell: PosterCell;
  size?: number;
  radius: number;
  bg: string;
  ink: string;
  onSettled?: () => void;
  style?: ViewStyle;
}) {
  const uri = absoluteUri(cell.thumb);
  const box: ViewStyle = { borderRadius: radius, overflow: 'hidden', backgroundColor: bg, ...(size ? { width: size, height: size } : {}) };

  if (!uri) {
    return (
      <View style={[box, { alignItems: 'center', justifyContent: 'center' }, style]}>
        <TextLike font={SERIF} size={Math.max(18, (size ?? 60) * 0.3)} color={ink}>
          {initialOf(cell.name)}
        </TextLike>
      </View>
    );
  }

  return (
    <View style={[box, style]}>
      <Image
        source={{ uri }}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        transition={0}
        cachePolicy="memory-disk"
        onLoadEnd={onSettled}
      />
    </View>
  );
}

/* ------------------------------------------------------------ 素笺 */

/**
 * 一物 · 纯文字。
 *
 * 没有照片位不是缺省，是取舍：这一套的全部力量来自「一张纸、一句话」。
 * 多件时它降级成「位置名 + 件数」，仍然成立 —— 所以素笺是唯一跨 single / multi 的。
 */
function PlainPoster({
  model,
  skin,
  accent,
}: {
  model: PosterModel;
  skin: PosterSkin;
  accent: string;
}) {
  const titleFont = skin.titleFont === 'serif' ? SERIF : SANS;
  const metaFont = skin.metaFont === 'serif' ? SERIF : SANS;
  const sub = model.kind === 'multi' ? model.countText : model.location;
  /* 数量与天数并成一行：两个都是「关于它的一个小事实」，
     分两行会把中间那块留白切碎，素笺的全部力量就在那块留白里 */
  const metaLine = [model.kind === 'single' ? model.countText : null, model.daysText]
    .filter((s): s is string => !!s)
    .join(' · ');

  return (
    <View style={{ flex: 1, backgroundColor: skin.paper, padding: skin.pad }}>
      {/* 顶行：出处与编号。编号没有就不占位 */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <TextLike font={metaFont} size={8} color={skin.ink3} spacing={2.4}>
          格 物
        </TextLike>
        {model.ordinal ? (
          <TextLike font={metaFont} size={8} color={skin.ink3} spacing={2.4}>
            {model.ordinal}
          </TextLike>
        ) : null}
      </View>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <TextLike font={titleFont} size={33} color={skin.ink} spacing={2} lineHeight={46} numberOfLines={3}>
          {model.title}
        </TextLike>

        <View style={{ width: 26, height: 1, backgroundColor: accent, marginTop: 22, marginBottom: 16 }} />

        {sub ? (
          <TextLike font={metaFont} size={11} color={skin.ink2} spacing={1.8} numberOfLines={2}>
            {sub}
          </TextLike>
        ) : null}

        {model.daysText ? (
          <TextLike
            font={metaFont}
            size={10}
            color={skin.ink3}
            spacing={0.8}
            numberOfLines={1}
            style={{ marginTop: 6 }}>
            {metaLine}
          </TextLike>
        ) : null}

        {model.quote ? (
          <View style={{ borderTopWidth: 1, borderTopColor: skin.line, paddingTop: 15, marginTop: 22 }}>
            <TextLike font={SERIF} size={13} color={skin.ink2} spacing={1.1} lineHeight={27} numberOfLines={3}>
              {model.quote}
            </TextLike>
          </View>
        ) : null}
      </View>

      <Signature skin={skin} date={model.dateText} />
    </View>
  );
}

/* ------------------------------------------------------------ 陈列 */

function GridPoster({
  model,
  skin,
  accent,
  onSettled,
}: {
  model: PosterModel;
  skin: PosterSkin;
  accent: string;
  onSettled?: () => void;
}) {
  const titleFont = skin.titleFont === 'serif' ? SERIF : SANS;
  const metaFont = skin.metaFont === 'serif' ? SERIF : SANS;

  /* 图格尺寸一律问 model —— 那里有断言守着「九件也不溢出画布」 */
  const { cellW, img } = gridMetrics(model.cells.length, skin.pad);
  const gap = GRID_METRICS.gap;

  return (
    <View style={{ flex: 1, backgroundColor: skin.paper, padding: skin.pad }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextLike font={metaFont} size={8} color={skin.ink3} spacing={3}>
            {model.eyebrow}
          </TextLike>
          <TextLike
            font={titleFont}
            size={18}
            color={skin.ink}
            spacing={1.1}
            lineHeight={26}
            numberOfLines={1}
            style={{ marginTop: 5 }}>
            {model.title}
          </TextLike>
        </View>
        <TextLike font={titleFont} size={13} color={accent} spacing={0.8}>
          {model.countText ?? ''}
        </TextLike>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, marginTop: GRID_METRICS.gridTop }}>
        {model.cells.map((cell, i) => (
          <View key={`${cell.name}-${i}`} style={{ width: cellW, alignItems: 'center' }}>
            <PhotoBox
              cell={cell}
              radius={3}
              bg={CELL_BG}
              ink={CELL_INK}
              onSettled={onSettled}
              style={{ width: img, height: img }}
            />
            <TextLike
              font={metaFont}
              size={9.5}
              color={skin.ink2}
              lineHeight={14}
              numberOfLines={1}
              style={{ marginTop: 5, maxWidth: cellW, textAlign: 'center' }}>
              {cell.name}
            </TextLike>
            {cell.note ? (
              <TextLike font={metaFont} size={8.5} color={skin.ink3} lineHeight={12}>
                {`剩 ${cell.note} 件`}
              </TextLike>
            ) : null}
          </View>
        ))}
      </View>

      <View style={{ flex: 1 }} />
      <Signature skin={skin} date={model.dateText} />
    </View>
  );
}

/* ------------------------------------------------------------ 一页账 */

function StatPoster({ model, skin, accent }: { model: PosterModel; skin: PosterSkin; accent: string }) {
  const stat = model.stat;
  const titleFont = skin.titleFont === 'serif' ? SERIF : SANS;
  const metaFont = skin.metaFont === 'serif' ? SERIF : SANS;
  if (!stat) return <View style={{ flex: 1, backgroundColor: skin.paper }} />;

  const barMax = 54;

  return (
    <View style={{ flex: 1, backgroundColor: skin.paper, padding: skin.pad }}>
      <TextLike font={metaFont} size={8.5} color={accent} spacing={3}>
        {model.eyebrow}
      </TextLike>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 14 }}>
        <TextLike font={titleFont} size={82} color={skin.ink} lineHeight={92} spacing={-1}>
          {model.title}
        </TextLike>
        <TextLike font={metaFont} size={14} color={skin.ink2} spacing={1.6} style={{ marginLeft: 8 }}>
          件
        </TextLike>
      </View>

      <View style={{ flexDirection: 'row', gap: 18, marginTop: 12 }}>
        <TextLike font={metaFont} size={9.5} color={skin.ink2} spacing={0.6}>
          {`${stat.cabinetCount} 个柜子`}
        </TextLike>
        <TextLike font={metaFont} size={9.5} color={skin.ink2} spacing={0.6}>
          {`${stat.slotCount} 个格位`}
        </TextLike>
        <TextLike font={metaFont} size={9.5} color={skin.ink2} spacing={0.6}>
          {`${stat.categoryCount} 个分类`}
        </TextLike>
      </View>

      <View style={{ flex: 1 }} />

      {/* 柱子：按最大值归一，最高那根用点缀色。柱顶标原始件数，没增量就不标 */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: barMax }}>
        {stat.bars.map((r, i) => {
          const count = stat.barCounts[i] ?? 0;
          const peak = r > 0 && r >= Math.max(...stat.bars);
          return (
            <View key={i} style={{ flex: 1, justifyContent: 'flex-end' }}>
              {peak && count > 0 ? (
                <TextLike font={metaFont} size={7} color={skin.ink3} lineHeight={10} style={{ textAlign: 'center', marginBottom: 2 }}>
                  {String(count)}
                </TextLike>
              ) : null}
              <View
                style={{
                  height: Math.max(2, Math.round(barMax * 0.72 * r)),
                  backgroundColor: peak ? accent : skin.line,
                  borderTopLeftRadius: 1,
                  borderTopRightRadius: 1,
                }}
              />
            </View>
          );
        })}
      </View>

      <TextLike font={metaFont} size={7.5} color={skin.ink3} spacing={0.3} style={{ marginTop: 10 }}>
        {stat.note}
      </TextLike>

      <View style={{ borderTopWidth: 1, borderTopColor: skin.line, marginTop: 10, paddingTop: 9 }}>
        <Signature skin={skin} date={model.dateText} right={model.daysText} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------ 暗房 */

/**
 * 照片满出血。
 *
 * 底部那层「渐变」是 18 条 9% 黑的叠层 —— 项目没装 expo-linear-gradient，
 * 而这个效果只在底部 220dp 内出现，叠层肉眼分不出台阶，不值得为它加一个模块。
 */
const SHADE_LAYERS = 18;
const SHADE_HEIGHT = 220;

function FullPoster({
  model,
  skin,
  onSettled,
}: {
  model: PosterModel;
  skin: PosterSkin;
  onSettled?: () => void;
}) {
  const titleFont = skin.titleFont === 'serif' ? SERIF : SANS;
  const metaFont = skin.metaFont === 'serif' ? SERIF : SANS;
  const cell: PosterCell = { name: model.title, thumb: model.photoThumb, note: null };

  return (
    <View style={{ flex: 1, backgroundColor: skin.paper }}>
      <PhotoBox
        cell={cell}
        radius={0}
        bg={skin.paper}
        ink={skin.ink3}
        onSettled={onSettled}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />

      {/* 叠层渐变：从透明到近黑。每层高度递减、透明度固定，叠加出来是一条平滑的坡 */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: SHADE_HEIGHT }}>
        {Array.from({ length: SHADE_LAYERS }, (_, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: SHADE_HEIGHT - (i * SHADE_HEIGHT) / SHADE_LAYERS,
              backgroundColor: SHADE_INK,
            }}
          />
        ))}
      </View>

      {model.ordinal ? (
        <TextLike
          font={metaFont}
          size={7}
          color={FULL_INK}
          spacing={3}
          style={{ position: 'absolute', right: skin.pad, top: skin.pad }}>
          {model.ordinal}
        </TextLike>
      ) : null}

      <View style={{ flex: 1 }} />

      <View style={{ paddingHorizontal: skin.pad, paddingBottom: skin.pad - 6 }}>
        <TextLike font={titleFont} size={24} color={skin.ink} spacing={1.2} lineHeight={32} numberOfLines={2}>
          {model.title}
        </TextLike>
        {model.location ? (
          <TextLike font={metaFont} size={9} color={skin.ink2} spacing={2} numberOfLines={1} style={{ marginTop: 10 }}>
            {model.location}
          </TextLike>
        ) : null}
        <TextLike font={metaFont} size={7} color={skin.ink3} spacing={2} style={{ marginTop: 14 }}>
          {`格物 · 收纳柜`}
        </TextLike>
      </View>
    </View>
  );
}
