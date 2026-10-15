import React, {useCallback, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {StackScreenProps} from '@amazon-devices/react-navigation__stack';
import type {RootStackParamList} from '../App';
import {FocusablePressable} from '../components/FocusablePressable';
import {cardFacts} from '../conversation/cardFacts';
import {useConversation} from '../hooks/useConversation';
import {useHousehold} from '../state/HouseholdContext';
import {colors, space, type} from '../theme';

type Props = StackScreenProps<RootStackParamList, 'Ask'>;

export function AskScreen({route}: Props) {
  const {data} = useHousehold();
  const caregivers = data?.caregivers ?? [];
  const patients = data?.patients ?? [];
  const [caregiverId, setCaregiverId] = useState<string>();
  const caregiver = caregivers.find((c) => c.id === caregiverId) ?? caregivers[0];
  const profileId = route.params.profileId;
  const patient = patients.find((p) => p.profile.id === profileId)?.profile;

  const convo = useConversation(profileId, caregiver?.name ?? 'Caregiver');
  const [draft, setDraft] = useState('');

  const submit = useCallback(() => {
    const text = draft;
    setDraft('');
    void convo.send(text);
  }, [convo, draft]);

  // Quick actions are fixed phrases, so the caregiver can act without typing. The weight comes from the profile,
  // and the dose itself is still computed by the server, never here.
  const quick = useMemo(() => {
    const list: Array<{label: string; text: string}> = [];
    if (patient?.kind === 'infant' && patient.weightLbs) {
      list.push({label: 'Fever dose', text: `${patient.name} is ${patient.weightLbs} pounds with a fever, how much Motrin?`});
    }
    list.push(
      {label: 'Sore throat', text: `${patient?.name ?? 'He'} has a sore throat`},
      {label: 'Restock Motrin', text: 'restock the Motrin'},
      {label: 'Confirm order', text: 'confirm the order'},
    );
    return list;
  }, [patient]);

  const latestReply = [...convo.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
  const facts = convo.card ? cardFacts(convo.card.cardType, convo.card.payload) : undefined;

  return (
    <View style={styles.screen}>
      <View style={styles.left}>
        <Text role="heading" style={styles.title}>
          Ask CareOS{patient ? ` about ${patient.name}` : ''}
        </Text>

        <View style={styles.row}>
          {caregivers.map((c) => (
            <FocusablePressable key={c.id} label={c.name} selected={c.id === caregiver?.id} onPress={() => setCaregiverId(c.id)} />
          ))}
        </View>

        {/* Stable live regions: text changes, the elements stay mounted so VoiceView announces the update. */}
        <Text aria-live="polite" style={styles.reply}>
          {latestReply}
        </Text>
        <Text role="alert" aria-live="assertive" style={styles.alert}>
          {convo.alertText ?? ''}
        </Text>
        <Text style={styles.progress}>{convo.busy ? convo.progress ?? '' : ''}</Text>

        <View style={styles.inputRow}>
          <TextInput
            aria-label="Message to CareOS"
            placeholder="Type, or hold the Alexa button and speak"
            placeholderTextColor={colors.textDim}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            returnKeyType="send"
            editable={!convo.busy}
            hasTVPreferredFocus
            style={styles.input}
          />
          <FocusablePressable label="Send" onPress={submit} />
        </View>

        <View style={styles.row}>
          {quick.map((q) => (
            <FocusablePressable key={q.label} label={q.label} onPress={() => void convo.send(q.text)} />
          ))}
        </View>

        <ScrollView style={styles.history}>
          {convo.messages.slice(-8).map((m) => (
            <Text key={m.id} style={[styles.line, m.role === 'user' && styles.lineUser]}>
              {m.role === 'user' ? 'You: ' : 'CareOS: '}
              {m.text}
            </Text>
          ))}
        </ScrollView>
      </View>

      <View style={[styles.card, facts?.tone === 'danger' && styles.cardDanger]}>
        {facts ? (
          <>
            <Text role="heading" style={styles.cardTitle}>
              {facts.title}
            </Text>
            {facts.headline ? <Text style={styles.headline}>{facts.headline}</Text> : null}
            {facts.lines.map((l, i) => (
              <Text key={i} style={styles.cardLine}>
                {l}
              </Text>
            ))}
            <FocusablePressable label="Dismiss" onPress={convo.clearCard} />
          </>
        ) : (
          <Text style={styles.dim}>Answers with a dose, a lock or a remedy appear here.</Text>
        )}
        <Text style={styles.disclaimer}>Demo — not a medical device.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, flexDirection: 'row', backgroundColor: colors.slate, padding: space.xl},
  left: {flex: 6, paddingRight: space.lg},
  title: {color: colors.text, fontSize: type.title, fontWeight: '700', marginBottom: space.sm},
  row: {flexDirection: 'row', flexWrap: 'wrap', marginBottom: space.sm},
  reply: {color: colors.text, fontSize: type.title, minHeight: 120, marginVertical: space.sm},
  alert: {color: colors.crimson, fontSize: type.body, fontWeight: '700', marginBottom: space.xs},
  progress: {color: colors.textDim, fontSize: type.caption, height: 32},
  inputRow: {flexDirection: 'row', alignItems: 'center', marginBottom: space.sm},
  input: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
    backgroundColor: colors.panel,
    borderRadius: 12,
    borderWidth: 4,
    borderColor: colors.panel,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  history: {flex: 1, marginTop: space.sm},
  line: {color: colors.textDim, fontSize: type.caption, marginBottom: space.xs},
  lineUser: {color: colors.text},
  card: {flex: 4, backgroundColor: colors.panel, borderRadius: 16, padding: space.lg, borderWidth: 4, borderColor: colors.teal},
  cardDanger: {borderColor: colors.crimson},
  cardTitle: {color: colors.text, fontSize: type.title, fontWeight: '700'},
  headline: {color: colors.text, fontSize: type.display, fontWeight: '700', marginVertical: space.sm},
  cardLine: {color: colors.text, fontSize: type.body, marginBottom: space.xs},
  dim: {color: colors.textDim, fontSize: type.body},
  disclaimer: {color: colors.textDim, fontSize: type.caption, marginTop: 'auto'},
});
