process.env.WAVE_TEST_NATIVE_API = '1';
process.env.WAVE_TEST_LOST_ENDED = '1';
require('./check-wave-handoff.cjs');
