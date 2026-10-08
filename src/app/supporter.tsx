/**
 * 格物 · 支持者
 *
 * 一页两态，取决于进门时的档位：
 *   未激活 → 贴码页（方案页 02 屏）：整串粘贴 → 本机验签 → 当场出结果
 *   已激活 → 状态页（方案页 03 屏）：只读，告诉用户「换机怎么办」「码丢了去哪找」
 *
 * 为什么两态共用一个路由：它们回答的是同一个问题（「我现在是不是支持者」），
 * 拆成两个路由会让「激活成功后该跳哪」变成一个需要维护的约定。
 *
 * ★ 这里是全应用唯一一处接收激活码的地方。别处（门控浮层、设置页）一律只做跳转 ——
 * 码的输入与校验只有一处实现，出错时才只有一个地方要查。
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button, IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { GUTTER, LIGHT_THEME_KEYS, Palette, Radius, Space, Type, type ThemeKey } from '@/constants/theme';
import { AFDIAN_URL } from '@/constants/site';
import { formatDateCN } from '@/lib/date';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles, useTheme } from '@/lib/theme';

/** 状态页里码只露头尾：这一屏常被旁人瞥一眼，全文没有展示价值 */
function abbreviate(code: string): string {
  if (code.length <= 24) return code;
  return `${code.slice(0, 12)}…${code.slice(-8)}`;
}

/** `?theme=xxx` 是门控浮层带过来的意图：他本来想换成哪套皮肤 */
function readThemeIntent(raw: string | undefined): ThemeKey | null {
  if (!raw) return null;
  return (LIGHT_THEME_KEYS as readonly string[]).includes(raw) ? (raw as ThemeKey) : null;
}

export default function SupporterScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { entitled, entitlement, activate } = useEntitlement();
  const { setLightKey } = useTheme();
  const params = useLocalSearchParams<{ theme?: string }>();
  const themeIntent = readThemeIntent(params.theme);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 刚在本页激活成功 —— 先把结果亮给用户看，别立刻跳到状态页把反馈吞掉 */
  const [justActivated, setJustActivated] = useState(false);

  const run = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await activate(draft);
      if (outcome.kind === 'ok') {
        setJustActivated(true);
        setDraft('');
        /* 他是从「想换皮肤」进来的，激活完就把它换上去 ——
           不然付完钱回来还得再点一次，那一下最容易让人怀疑「是不是没激活成功」 */
        if (themeIntent) setLightKey(themeIntent);
      } else {
        setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const showingForm = !entitled || justActivated;

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <Meta tone="ink3" style={styles.topHint}>
          {entitled ? '已激活' : ''}
        </Meta>
      </View>

      {showingForm ? (
        <PageHeader
          title="激活支持者"
          subtitle="把激活码整串粘贴进来，格物在本机校验，不上传任何东西。"
        />
      ) : (
        <PageHeader
          title="支持者状态"
          subtitle="一个激活码不绑设备、不限台数。换手机把同一串码再粘一次即可，不需要联网登记。"
        />
      )}

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {showingForm ? (
          <>
            <Gutter>
              <View style={styles.codeBox}>
                <Label tone="ink3">激活码</Label>
                {/* 多行输入：码有 160~210 个字符，单行框只能看到尾巴，
                    用户没法确认自己是否整串粘进来了 */}
                <TextInput
                  value={draft}
                  onChangeText={(next) => {
                    setDraft(next);
                    if (error) setError(null);
                  }}
                  placeholder="GW1-……"
                  placeholderTextColor={Palette.ink4}
                  style={styles.codeField}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  allowFontScaling={false}
                  editable={!justActivated}
                />
                {draft.length > 0 && !justActivated ? (
                  <View style={styles.codeFoot}>
                    <Meta tone="ink4">{`已输入 ${draft.trim().length} 个字符`}</Meta>
                    <Pressable accessibilityRole="button" onPress={() => setDraft('')} hitSlop={8}>
                      <Meta color={Palette.brand}>清空</Meta>
                    </Pressable>
                  </View>
                ) : (
                  <Meta tone="ink4" style={styles.codeHint}>
                    在订单页长按选中整串 → 复制，回到这里长按输入框 → 粘贴
                  </Meta>
                )}
              </View>
            </Gutter>

            {justActivated ? (
              <SectionCard title="校验结果">
                <Gutter>
                  <Card padded={false}>
                    <View style={styles.row}>
                      <Meta tone="ink3" style={styles.rowKey}>
                        状态
                      </Meta>
                      <Body color={Palette.sage} style={styles.rowValue}>
                        已激活 · 支持者
                      </Body>
                      <Ionicons name="checkmark" size={16} color={Palette.sage} />
                    </View>
                    <View style={styles.row}>
                      <Meta tone="ink3" style={styles.rowKey}>
                        可用设备
                      </Meta>
                      <Body style={styles.rowValue}>不限 · 换机再粘一次</Body>
                    </View>
                    {entitlement.issuedOn ? (
                      <View style={[styles.row, styles.rowLast]}>
                        <Meta tone="ink3" style={styles.rowKey}>
                          签发于
                        </Meta>
                        <Body tone="ink2" style={styles.rowValue}>
                          {formatDateCN(entitlement.issuedOn)}
                        </Body>
                      </View>
                    ) : null}
                  </Card>

                  <Meta tone="ink4" style={styles.afterNote}>
                    验签在本机完成，不上传任何东西，也不需要联网。支持者皮肤、批量与 AI 入口现在都已解锁。
                  </Meta>
                </Gutter>
              </SectionCard>
            ) : (
              <>
                <Gutter>
                  <Meta tone="ink4" style={styles.lead}>
                    {`激活码里有签发日期与一个订单标识，不含姓名、手机号，也不含任何设备或硬件信息。`}
                  </Meta>
                </Gutter>

                {error ? (
                  <Gutter>
                    <Card tone="inset" style={styles.errorCard}>
                      <View style={styles.errorRow}>
                        <Ionicons name="alert-circle" size={15} color={Palette.clay} />
                        <Meta color={Palette.clay} style={styles.errorText}>
                          {error}
                        </Meta>
                      </View>
                    </Card>
                  </Gutter>
                ) : null}

                <SectionCard title="还没买？">
                  <Gutter>
                    <Card>
                      <Title style={styles.buyTitle}>支持者档 · ¥28</Title>
                      <Meta tone="ink3" style={styles.buyLine}>
                        一次买断，含 v2 内全部支持者功能：五套主题、批量操作、AI 功能、新功能优先体验。
                      </Meta>
                      <Meta tone="ink4" style={styles.buyLine}>
                        免费档不受影响 —— 收纳、到期提醒、库存、照片、备份恢复全部照旧。
                      </Meta>
                      {AFDIAN_URL.length > 0 ? (
                        <Pressable
                          accessibilityRole="button"
                          style={styles.buyLink}
                          onPress={() => router.push('/supporter')}>
                          <Meta color={Palette.brand}>在爱发电购买后会自动收到激活码</Meta>
                        </Pressable>
                      ) : (
                        <Meta tone="ink4" style={styles.buyLine}>
                          购买入口还没开放，暂时只能粘贴已有的激活码。
                        </Meta>
                      )}
                    </Card>
                  </Gutter>
                </SectionCard>
              </>
            )}
          </>
        ) : (
          <>
            <Gutter>
              <Meta tone="ink4" style={styles.lead}>
                激活码不绑设备、不限台数。换手机把同一串码再粘一次即可，不需要联网登记。
              </Meta>
            </Gutter>

            <SectionCard title="当前档位">
              <Gutter>
                <Card padded={false}>
                  <View style={styles.row}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      档位
                    </Meta>
                    <Body style={styles.rowValue}>支持者 · 一次买断</Body>
                    <Meta color={Palette.sage}>在用</Meta>
                  </View>
                  <View style={styles.row}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      激活码
                    </Meta>
                    <View style={styles.rowValue}>
                      <Body tone="ink2">{abbreviate(entitlement.code ?? '')}</Body>
                      {entitlement.issuedOn ? (
                        <Meta tone="ink4">{`签发于 ${formatDateCN(entitlement.issuedOn)}`}</Meta>
                      ) : null}
                      {entitlement.label ? <Meta tone="ink4">{`标识 ${entitlement.label}`}</Meta> : null}
                    </View>
                  </View>
                  <View style={[styles.row, styles.rowLast]}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      可用设备
                    </Meta>
                    <View style={styles.rowValue}>
                      <Body>不限</Body>
                      <Meta tone="ink4">码里不含任何设备信息</Meta>
                    </View>
                  </View>
                </Card>
              </Gutter>
            </SectionCard>

            <SectionCard title="权益">
              <Gutter>
                <Card padded={false}>
                  <View style={styles.row}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      有效期
                    </Meta>
                    <Body style={styles.rowValue}>永久</Body>
                    <Meta tone="ink4">不订阅、不续费</Meta>
                  </View>
                  <View style={[styles.row, styles.rowLast]}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      包含
                    </Meta>
                    <Body style={styles.rowValue}>皮肤 / 批量 / AI / 优先体验</Body>
                  </View>
                </Card>
              </Gutter>
            </SectionCard>

            <SectionCard title="换机与凭证">
              <Gutter>
                <Card padded={false}>
                  <View style={styles.row}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      换机
                    </Meta>
                    <Body style={styles.rowValue}>再粘一次这串码</Body>
                  </View>
                  <View style={[styles.row, styles.rowLast]}>
                    <Meta tone="ink3" style={styles.rowKey}>
                      码丢了
                    </Meta>
                    <Body style={styles.rowValue}>爱发电「我的订单」里可重看</Body>
                  </View>
                </Card>

                {/* 没有服务端可查，这串码就是唯一的凭证 —— 所以整串给出来、可长按选中复制，
                    而不是只显示缩略。长按复制是系统能力，不引额外的原生模块。 */}
                <Card tone="inset" style={styles.fullCodeCard}>
                  <Label tone="ink3">完整激活码 · 长按可复制</Label>
                  <Body selectable style={styles.fullCode}>
                    {entitlement.code ?? ''}
                  </Body>
                </Card>

                <Meta tone="ink4" style={styles.afterNote}>
                  建议把这串码连同爱发电订单一起存进微信文件传输助手或网盘。格物这边没有服务器，也没有云端账本，
                  手机丢了就只有订单页那一份了。
                </Meta>
              </Gutter>
            </SectionCard>
          </>
        )}
      </ScrollView>

      <View style={styles.foot}>
        {showingForm ? (
          justActivated ? (
            <Button label="完成" onPress={() => router.back()} />
          ) : (
            <Button
              label={busy ? '校验中…' : '激活'}
              onPress={() => void run()}
              disabled={busy || draft.trim().length === 0}
              loading={busy}
            />
          )
        ) : (
          <Button label="返回" tone="secondary" onPress={() => router.back()} />
        )}
      </View>
    </Screen>
  );
}

const useStyles = makeStyles((Palette) => ({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Space.xs,
    paddingTop: Space.xs,
  },
  topHint: { marginLeft: Space.xs },
  scroll: { paddingBottom: Space.xxl },

  /* 码框：虚线边 + 内凹底色，与其它卡片区分开 —— 这是「要动手」的区域，
     不是「看一眼」的信息卡 */
  codeBox: {
    marginTop: Space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: Palette.line,
    borderRadius: Radius.card,
    backgroundColor: Palette.inset,
    padding: Space.md,
  },
  codeField: {
    minHeight: 96,
    marginTop: Space.sm,
    padding: 0,
    ...(Type.body as object),
    fontSize: 13,
    lineHeight: 20,
    color: Palette.ink,
    textAlignVertical: 'top',
  },
  codeFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeHint: { marginTop: Space.xs, lineHeight: 18 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.line3,
  },
  rowLast: { borderBottomWidth: 0 },
  rowKey: { width: 52, flexShrink: 0 },
  rowValue: { flex: 1, minWidth: 0 },

  lead: { marginTop: Space.md, lineHeight: 20 },

  errorCard: { marginTop: Space.md, padding: Space.md },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.xs },
  errorText: { flex: 1, lineHeight: 19 },

  afterNote: { marginTop: Space.md, lineHeight: 20 },

  buyTitle: { fontSize: 17 },
  buyLine: { marginTop: Space.xs, lineHeight: 20 },
  buyLink: { marginTop: Space.md },

  fullCodeCard: { marginTop: Space.md, padding: Space.md },
  fullCode: { marginTop: Space.xs, fontSize: 13, lineHeight: 21 },

  foot: {
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
    paddingBottom: Space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
    backgroundColor: Palette.canvas,
  },
}));
