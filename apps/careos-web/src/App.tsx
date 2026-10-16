import { useCallback, useEffect, useState } from "react";
import { AlexaPane } from "./components/AlexaPane";
import { DashboardPane } from "./components/DashboardPane";
import { useConversation } from "./hooks/useConversation";
import { useHousehold } from "./hooks/useHousehold";
import { useSpeech } from "./hooks/useSpeech";

export function App() {
  const household = useHousehold();
  const [patientId, setPatientId] = useState("leo");
  const [caregiver, setCaregiver] = useState("Sarah");

  const caregivers = household.data?.caregivers ?? [];
  const patient = household.data?.patients.find((p) => p.profile.id === patientId);

  // Fall back to the first seeded caregiver if the default name isn't in the data.
  useEffect(() => {
    if (caregivers.length > 0 && !caregivers.some((c) => c.name === caregiver)) setCaregiver(caregivers[0]!.name);
  }, [caregivers, caregiver]);

  // Speech lives above the conversation so a spoken reply and a mic transcript share one instance.
  const [pendingSend, setPendingSend] = useState<string>();
  const speech = useSpeech(setPendingSend);
  const convo = useConversation({ activeProfile: patientId, caregiver, caregivers, onSwitchCaregiver: setCaregiver, onReply: speech.speak });

  const { send } = convo;
  useEffect(() => {
    if (pendingSend) {
      void send(pendingSend);
      setPendingSend(undefined);
    }
  }, [pendingSend, send]);

  const onPatient = useCallback((id: string) => setPatientId(id), []);

  return (
    <div className="grid h-full grid-cols-1 divide-slate-800 lg:grid-cols-2 lg:divide-x">
      <AlexaPane convo={convo} speech={speech} patient={patient} caregiver={caregiver} caregivers={caregivers} />
      <DashboardPane household={household} patientId={patientId} onPatient={onPatient} caregiver={caregiver} onCaregiver={setCaregiver} />
    </div>
  );
}
