process.env.WAVE_TEST_NATIVE_API = '1';
process.env.WAVE_TEST_HEALTHY_HANDOFF = '1';
require('./check-wave-handoff.cjs');
