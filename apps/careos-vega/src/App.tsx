import React from 'react';
import {enableFreeze, enableScreens} from '@amazon-devices/react-native-screens';
import {NavigationContainer} from '@amazon-devices/react-navigation__native';
import {createStackNavigator} from '@amazon-devices/react-navigation__stack';
import {ErrorBoundary} from './components/ErrorBoundary';
import {AskScreen} from './screens/AskScreen';
import {HomeScreen} from './screens/HomeScreen';
import {HouseholdProvider} from './state/HouseholdContext';

// Required at startup for navigation performance and D-pad screen management.
enableScreens();
enableFreeze();

export type RootStackParamList = {
  Home: undefined;
  Ask: {profileId: string};
  // Phase 6: DoubleDoseIntercept / card overlays are added here as transparent modals.
};

const Stack = createStackNavigator<RootStackParamList>();

export const App = () => (
  <ErrorBoundary>
    <HouseholdProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Ask" component={AskScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </HouseholdProvider>
  </ErrorBoundary>
);
