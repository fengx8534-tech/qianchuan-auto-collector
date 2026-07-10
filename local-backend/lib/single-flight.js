function createSingleFlight() {
  let inFlight = null;
  return function runSingleFlight(runner) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(runner)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

module.exports = { createSingleFlight };
