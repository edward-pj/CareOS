import React, {useCallback, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Carousel, type CarouselRenderInfo} from '@amazon-devices/vega-carousel';
import type {ActiveLock, InventoryItem, PatientSnapshot} from '../api/types';
import {api} from '../api/client';
import {FocusablePressable} from '../components/FocusablePressable';
import type {StackScreenProps} from '@amazon-devices/react-navigation__stack';
import type {RootStackParamList} from '../App';
import {useHousehold} from '../state/HouseholdContext';
import {useNow} from '../hooks/useNow';
import {colors, space, type} from '../theme';
import {formatRemaining} from '../utils/time';

const ITEM_W = 360;
const ITEM_H = 150;

const LOCK_COPY: Record<ActiveLock['status'], string> = {
  DOUBLE_DOSE_LOCKED: 'Too soon for another dose',
  DAILY_MAX_REACHED: 'Daily maximum reached',
};

function LockRow({lock, nowMs}: {lock: ActiveLock; nowMs: number}) {
  const remaining = formatRemaining(Date.parse(lock.next_eligible_time) - nowMs);
  return (
    <View style={styles.lockRow} accessible aria-label={`${lock.ingredient}: ${LOCK_COPY[lock.status]}. Next dose in ${remaining}`}>
      <Text style={styles.lockIngredient}>{lock.ingredient}</Text>
      <Text style={styles.lockStatus}>{LOCK_COPY[lock.status]}</Text>
      <Text style={styles.lockCountdown}>{remaining}</Text>
    </View>
  );
}

// Selection (border + scale) is drawn by Carousel V2 via selectionBorder/itemStyle, so the card has no focus styling.
const InventoryCard = React.memo(function InventoryCard({item}: {item: InventoryItem}) {
  const low = item.remaining <= item.lowThreshold;
  const unit = item.unit === 'pantry' ? '' : ` ${item.unit}`;
  return (
    <View
      accessible
      role="button"
      aria-label={`${item.name}, ${item.remaining}${unit} left${low ? ', running low' : ''}`}
      style={[styles.card, low && styles.cardLow]}>
      <Text style={styles.cardName}>{item.name}</Text>
      <Text style={[styles.cardQty, low && styles.cardQtyLow]}>
        {item.remaining}
        {unit}
      </Text>
    </View>
  );
});

function PatientPanel({patient, nowMs}: {patient: PatientSnapshot; nowMs: number}) {
  const {profile, active_locks: locks} = patient;
  const weight = profile.weight_kg ? `${profile.weight_kg} kg` : 'weight not set';
  return (
    <View style={styles.panel}>
      <Text role="heading" style={styles.panelTitle}>
        {profile.name}
      </Text>
      <Text style={styles.dim}>
        {profile.kind === 'infant' ? `${Math.floor(profile.age_days / 30)} months` : 'adult'} · {weight}
      </Text>
      {locks.length === 0 ? (
        <Text style={styles.clear}>No active dose locks</Text>
      ) : (
        locks.map((l) => <LockRow key={l.ingredient} lock={l} nowMs={nowMs} />)
      )}
    </View>
  );
}

export function HomeScreen({navigation}: StackScreenProps<RootStackParamList, 'Home'>) {
  const {data, clockSkewMs, error, loading, refresh} = useHousehold();
  const nowMs = useNow(clockSkewMs);
  const [selectedId, setSelectedId] = useState<string>();

  const patients = data?.patients ?? [];
  const selected = patients.find((p) => p.profile.id === selectedId) ?? patients[0];

  const inventory = data?.inventory;
  const dataAdapter = useMemo(
    () => ({
      getItem: (index: number) => inventory?.[index],
      getItemCount: () => inventory?.length ?? 0,
      getItemKey: (info: CarouselRenderInfo<InventoryItem>) => info.item.id,
      notifyDataError: () => false,
    }),
    [inventory],
  );
  const renderItem = useCallback((info: CarouselRenderInfo<InventoryItem>) => <InventoryCard item={info.item} />, []);

  const resetDemo = useCallback(async () => {
    await api.resetDemo().catch(() => undefined);
    await refresh();
  }, [refresh]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text role="heading" style={styles.title}>
          CareOS
        </Text>
        <View style={styles.chips}>
          {patients.map((p, i) => (
            <FocusablePressable
              key={p.profile.id}
              label={p.profile.name}
              selected={p.profile.id === selected?.profile.id}
              hasTVPreferredFocus={i === 0}
              onPress={() => setSelectedId(p.profile.id)}
            />
          ))}
        </View>
      </View>

      {/* Live region: connection problems are announced even when focus is elsewhere. */}
      <Text aria-live="polite" style={styles.error}>
        {error ?? ''}
      </Text>

      {loading && !data ? <Text style={styles.dim}>Loading household…</Text> : null}
      {selected ? <PatientPanel patient={selected} nowMs={nowMs} /> : null}

      {data && data.inventory.length > 0 ? (
        <View style={styles.section}>
          <Text role="heading" style={styles.sectionTitle}>
            Household stock
          </Text>
          <Carousel
            uniqueId="inventory"
            dataAdapter={dataAdapter}
            renderItem={renderItem}
            orientation="horizontal"
            selectionStrategy="natural"
            trapSelectionOnOrientation
            itemStyle={{itemPadding: space.sm, selectedItemScaleFactor: 1.05}}
            selectionBorder={{borderWidth: 4, borderColor: colors.focus, borderRadius: 12, borderStrategy: 'outset'}}
            containerStyle={styles.carousel}
          />
        </View>
      ) : null}

      <View style={styles.footer}>
        {selected ? (
          <FocusablePressable label={`Ask about ${selected.profile.name}`} onPress={() => navigation.navigate('Ask', {profileId: selected.profile.id})} />
        ) : null}
        <FocusablePressable label="Retry" onPress={() => void refresh()} />
        <FocusablePressable label="Reset demo" onPress={() => void resetDemo()} />
        <Text style={styles.disclaimer}>Demo — not a medical device.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.slate},
  content: {padding: space.xl},
  headerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md},
  title: {color: colors.text, fontSize: type.title, fontWeight: '700'},
  chips: {flexDirection: 'row'},
  panel: {backgroundColor: colors.panel, borderRadius: 16, padding: space.lg, marginBottom: space.lg},
  panelTitle: {color: colors.text, fontSize: type.title, fontWeight: '700'},
  dim: {color: colors.textDim, fontSize: type.caption, marginBottom: space.sm},
  clear: {color: colors.emerald, fontSize: type.body, marginTop: space.sm},
  lockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderLeftWidth: 8,
    borderLeftColor: colors.crimson,
    paddingLeft: space.md,
    marginTop: space.sm,
  },
  lockIngredient: {color: colors.text, fontSize: type.body, fontWeight: '700', flex: 1},
  lockStatus: {color: colors.crimson, fontSize: type.body, flex: 2},
  lockCountdown: {color: colors.text, fontSize: type.display, fontWeight: '700'},
  section: {marginBottom: space.lg},
  sectionTitle: {color: colors.text, fontSize: type.body, fontWeight: '700', marginBottom: space.sm},
  carousel: {height: ITEM_H + space.md},
  card: {
    width: ITEM_W,
    height: ITEM_H,
    padding: space.md,
    borderRadius: 12,
    backgroundColor: colors.panel,
    justifyContent: 'space-between',
  },
  cardLow: {backgroundColor: '#3B1D1D'},
  cardName: {color: colors.text, fontSize: type.body},
  cardQty: {color: colors.emerald, fontSize: type.title, fontWeight: '700'},
  cardQtyLow: {color: colors.crimson},
  error: {color: colors.crimson, fontSize: type.caption, marginBottom: space.sm},
  footer: {flexDirection: 'row', alignItems: 'center', marginTop: space.md},
  disclaimer: {color: colors.textDim, fontSize: type.caption, marginLeft: space.lg},
});
