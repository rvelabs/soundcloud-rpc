process.env.WAVE_TEST_MODAL_SEARCH = '1';
process.env.WAVE_TEST_MODAL_CLOSED = '1';
process.env.WAVE_TEST_BACKGROUND_INPUT_STALL = '1';
require('./check-wave-handoff.cjs');
