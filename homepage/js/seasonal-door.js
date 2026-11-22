(() => {
  const door = document.querySelector('#christmas-door');
  const collection = document.querySelector('#winter-stories');
  const toggle = document.querySelector('#christmas-sound-toggle');
  const skip = document.querySelector('#skip-christmas-door');
  if (!door || !collection || !toggle || !skip) return;

  let sound = true;
  let entering = false;
  let audioContext;

  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    sound = !sound;
    toggle.setAttribute('aria-pressed', String(sound));
    toggle.textContent = `Sound: ${sound ? 'on' : 'off'}`;
  });

  async function playChime() {
    if (!sound) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext ??= new AudioContextClass();
      if (audioContext.state === 'suspended') await audioContext.resume();
      const now = audioContext.currentTime;
      [659.25, 783.99, 987.77].forEach((frequency, index) => {
        const start = now + index * 0.12;
        const oscillator = audioContext.createOscillator();
        const volume = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        volume.gain.setValueAtTime(0.0001, start);
        volume.gain.exponentialRampToValueAtTime(0.09, start + 0.025);
        volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.72);
        oscillator.connect(volume);
        volume.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.74);
      });
    } catch {
      // The doorway still opens when audio is unavailable.
    }
  }

  function showCollection() {
    collection.focus({ preventScroll: true });
    collection.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
    history.replaceState(null, '', '#winter-stories');
  }

  door.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (entering) return;
    entering = true;
    door.classList.add('door-open');
    void playChime();
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1100;
    window.setTimeout(() => {
      showCollection();
      entering = false;
    }, delay);
  });

  skip.addEventListener('click', event => {
    event.preventDefault();
    showCollection();
  });
})();
