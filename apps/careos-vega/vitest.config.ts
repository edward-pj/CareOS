import {defineConfig} from 'vitest/config';

// Only pure TypeScript modules are tested here (no react-native imports); UI needs the Vega Virtual Device.
export default defineConfig({test: {include: ['tst/**/*.test.ts'], environment: 'node'}});
