import React, {createContext, useContext, type ReactNode} from 'react';
import {useHouseholdState, type HouseholdState} from '../hooks/useHouseholdState';

const Ctx = createContext<HouseholdState | undefined>(undefined);

/** One state poll shared by every screen, instead of each screen polling on its own. */
export function HouseholdProvider({children}: {children: ReactNode}) {
  const value = useHouseholdState();
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHousehold(): HouseholdState {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useHousehold must be used inside HouseholdProvider');
  }
  return v;
}
