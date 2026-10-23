import { useCallback, useEffect, useState } from "react";
import { api } from "./api/client";
import { CardView } from "./components/Cards";
import { CareSheet } from "./components/CareSheet";
import { Dock, type Menu } from "./components/Dock";
import { Drawer } from "./components/Drawer";
import { EmergencyOverlay } from "./components/EmergencyOverlay";
import { Header } from "./components/Header";
import { IdleCard } from "./components/IdleCard";
import { GlassDefs, Orb } from "./components/Orb";
import { People } from "./components/People";
import { Rail } from "./components/Rail";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShopScreen } from "./components/Shop";
import { VoiceDock } from "./components/VoiceDock";
import { useConversation } from "./hooks/useConversation";
import { rememberPreview } from "./lib/photos";
import { useHousehold } from "./hooks/useHousehold";
import { useNow } from "./hooks/useNow";
import { useSettings } from "./hooks/useSettings";
import { useShop } from "./hooks/useShop";
import { useSpeech } from "./hooks/useSpeech";

export function App() {
  const household = useHousehold();
  const [settings, updateSettings] = useSettings();
  const [patientId, setPatientId] = useState("leo");
  const [caregiver, setCaregiver] = useState("Sarah");
  const [emergency, setEmergency] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showShop, setShowShop] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [showPrompts, setShowPrompts] = useState(true);
  const shop = useShop();

  // A delivery or a logged dose changes a bottle: refresh the idle card's supplies line right away.
  const { refresh: refreshHousehold } = household;
  const lastShopEvent = shop.events[shop.events.length - 1];
  useEffect(() => {
    if (lastShopEvent && (lastShopEvent.type === "inventory.changed" || lastShopEvent.type === "order.delivered" || lastShopEvent.type === "shop.updated")) void refreshHousehold();
  }, [lastShopEvent, refreshHousehold]);
  const shopBadge = (shop.view?.cart?.lines.length ?? 0) + (shop.view?.orders.filter((o) => o.status === "ORDERED").length ?? 0);

  const caregivers = household.data?.caregivers ?? [];
  const patient = household.data?.patients.find((p) => p.profile.id === patientId);
  const now = useNow(household.clockSkewMs);

  // Fall back to the first seeded caregiver if the default name isn't in the data.
  useEffect(() => {
    if (caregivers.length > 0 && !caregivers.some((c) => c.name === caregiver)) setCaregiver(caregivers[0]!.name);
  }, [caregivers, caregiver]);

  // Speech lives above the conversation so a spoken reply and a mic transcript share one instance.
  const [pendingSend, setPendingSend] = useState<string>();
  const speech = useSpeech(setPendingSend, settings.speakReplies);
  const convo = useConversation({ activeProfile: patientId, caregiver, caregivers, onSwitchCaregiver: setCaregiver, onReply: speech.speak });

  const { send } = convo;
  useEffect(() => {
    if (pendingSend) {
      void send(pendingSend);
      setPendingSend(undefined);
    }
  }, [pendingSend, send]);

  const [photoBusy, setPhotoBusy] = useState(false);
  const { showPayload } = convo;
  const onPhoto = useCallback(async (kind: "prescription" | "label", file: File) => {
    setPhotoBusy(true);
    const who = patient?.profile.name ?? patientId;
    const said = kind === "prescription" ? `Photo of ${who}'s prescription` : "Photo of the medicine bottle label";
    try {
      const { upload_id } = await api.uploadPhoto(file);
      rememberPreview(upload_id, file);
      showPayload(said, kind === "prescription" ? await api.readPrescriptionPhoto(upload_id, patientId) : await api.readLabelPhoto(upload_id, patientId));
    } catch (e) {
      showPayload(said, { status: "UNAVAILABLE", card_type: null, speech: e instanceof Error ? e.message : "I couldn't read that photo." });
    } finally { setPhotoBusy(false); }
  }, [patient, patientId, showPayload]);

  const openHelp = useCallback(() => setEmergency(true), []);
  const reset = useCallback(async () => {
    setResetting(true);
    try { await api.resetDemo(); await household.refresh(); } finally { setResetting(false); }
  }, [household]);

  const lastReply = [...convo.messages].reverse().find((m) => m.role === "assistant");

  const activeMenu: Menu = showShop ? "orders" : showSettings ? "settings" : showCard ? "card" : "home";
  const selectMenu = (m: Menu) => {
    setShowShop(m === "orders");
    setShowSettings(m === "settings");
    setShowCard(m === "card");
  };

  return (
    <div className="stage">
      <div className="device">
        <GlassDefs />
        <Header household={household} patientId={patientId} onPatient={setPatientId} onEmergency={openHelp} onInspector={() => setInspectOpen((o) => !o)} inspectorOpen={inspectOpen} />

        {convo.alertText && (
          <div role="alert" className="glass glass-danger mx-8.5 mt-3 shrink-0 rounded-full px-5.5 py-2 text-[16px] font-semibold text-red-100">⛔ {convo.alertText}</div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col">
          {settings.screenless ? (
            <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-17 text-center" aria-label="Speaker-only view">
              <div className="text-[16px] tracking-widest text-muted">Screenless mode · this is everything a speaker would say</div>
              <p className="text-[40px] font-semibold leading-tight text-white" data-testid="screenless-text">{convo.busy ? "Checking safety rules…" : lastReply?.text ?? "Say “Alexa, ask CareOS…”"}</p>
              {lastReply?.followup && !convo.busy && <p className="text-[26px] text-soft">{lastReply.followup}</p>}
            </main>
          ) : (
            <main className="grid min-h-0 flex-1 grid-cols-[272px_minmax(0,1fr)_340px] gap-6 px-8 py-4">
              <People household={household} convo={convo} speech={speech} patientId={patientId} onPatient={setPatientId} />
              <section className="min-h-0" aria-label="Active card" aria-live="polite">
                {convo.card ? (
                  <CardView
                    key={convo.card.key}
                    type={convo.card.cardType}
                    payload={convo.card.payload}
                    ctx={{ patientId, caregiver, onSend: send, disabled: convo.busy, onHelp: openHelp, onOpenShop: () => setShowShop(true), patientName: patient?.profile.name ?? patientId, onShowPayload: convo.showPayload }}
                  />
                ) : convo.busy ? (
                  <section className="flex h-full flex-col items-center justify-center gap-5.5 text-center" aria-label="Checking safety rules">
                    <Orb size={240} hue={-135} active />
                    <div className="flex flex-col items-center gap-2">
                      <p className="text-[36px] font-semibold text-white">Checking safety rules…</p>
                      <p className="text-[16px] text-dim">{convo.progress}</p>
                    </div>
                  </section>
                ) : (
                  <IdleCard household={household} snap={patient} listening={speech.listening} />
                )}
              </section>
              <Rail snap={patient} now={now} />
            </main>
          )}
          {(showSettings || showCard) && (
            <div className="absolute inset-x-8.5 inset-y-3 z-20">
              {showSettings && <SettingsPanel settings={settings} update={updateSettings} onClose={() => setShowSettings(false)} onReset={() => void reset()} resetting={resetting} showPrompts={showPrompts} onShowPrompts={setShowPrompts} />}
              {showCard && !showSettings && <CareSheet snap={patient} now={now} onClose={() => setShowCard(false)} />}
            </div>
          )}
        </div>

        <VoiceDock busy={convo.busy} send={(t) => void send(t)} speech={speech} patient={patient} caregiver={caregiver} caregivers={caregivers} onCaregiver={setCaregiver} showPresets={showPrompts} dock={{ active: activeMenu, onSelect: selectMenu, shopBadge }} onPhoto={(k, f) => void onPhoto(k, f)} photoBusy={photoBusy} />
        <Drawer household={household} convo={convo} patientId={patientId} caregiver={caregiver} open={inspectOpen} onClose={() => setInspectOpen(false)} />

        {showShop && <div className="absolute inset-0 z-40"><ShopScreen shop={shop} mode="overlay" onClose={() => setShowShop(false)} /></div>}
        {emergency && <EmergencyOverlay onClose={() => setEmergency(false)} />}
      </div>
    </div>
  );
}
