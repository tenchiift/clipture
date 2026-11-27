const SAMPLE_CLIPS = [
  {
    id: 'clip-url',
    category: 'URL',
    label: 'URL',
    tone: 'butter',
    preview: 'https://github.com/tenchiift/clipture',
    copyText: 'https://github.com/tenchiift/clipture',
  },
  {
    id: 'clip-code',
    category: 'CODE',
    label: 'CODE',
    tone: 'sage',
    preview: 'const formatPrice = (n) => `$${n.toFixed(2)}`;',
    copyText: 'const formatPrice = (n) => `$${n.toFixed(2)}`;',
  },
  {
    id: 'clip-secret',
    category: 'SECRET',
    label: 'SECRET · PRIVACY GUARD',
    tone: 'coral',
    masked: 'sk-proj-••••••••••••••••••••',
    revealed: 'sk-proj-demo-local-only-98y2kL',
  },
  {
    id: 'clip-image',
    category: 'IMAGE',
    label: 'IMAGE · 1920×1080 · 1.73 MB',
    tone: 'slate',
    preview: 'WopGnop Digital Art Wallpaper.jpg',
    copyText: 'WopGnop Digital Art Wallpaper.jpg',
  },
];

const clipListEl = document.getElementById('clip-list');
const searchInputEl = document.getElementById('playground-search');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));

let activeCategory = 'ALL';
let searchQuery = '';
let secretRevealed = false;

function renderClips() {
  const q = searchQuery.trim().toLowerCase();
  const filtered = SAMPLE_CLIPS.filter((clip) => {
    const matchesCategory = activeCategory === 'ALL' || clip.category === activeCategory;
    const text = (clip.preview || clip.masked || '') + ' ' + clip.label;
    const matchesSearch = !q || text.toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });

  if (filtered.length === 0) {
    clipListEl.innerHTML =
      '<div class="empty-state">No matching clips in playground. Try clearing your filter.</div>';
    return;
  }

  clipListEl.innerHTML = '';
  for (const clip of filtered) {
    const card = document.createElement('div');
    card.className = `clip-card clip-card--${clip.tone}`;

    const meta = document.createElement('div');
    meta.className = 'clip-meta';

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = clip.label;

    const content = document.createElement('div');
    content.className = 'clip-content';
    content.textContent =
      clip.category === 'SECRET'
        ? secretRevealed
          ? clip.revealed
          : clip.masked
        : clip.preview;

    meta.append(label, content);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nb-press clip-action-btn';

    if (clip.category === 'SECRET') {
      btn.textContent = secretRevealed ? 'Mask' : 'Reveal';
      btn.addEventListener('click', () => {
        secretRevealed = !secretRevealed;
        renderClips();
      });
    } else {
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(clip.copyText);
          btn.textContent = 'Copied!';
        } catch {
          btn.textContent = 'Copied!';
        }
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      });
    }

    card.append(meta, btn);
    clipListEl.appendChild(card);
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    activeCategory = btn.dataset.category || 'ALL';
    for (const b of tabButtons) {
      b.classList.toggle('active', b === btn);
    }
    renderClips();
  });
}

searchInputEl.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderClips();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInputEl.focus();
  } else if (e.key === 'Escape' && document.activeElement === searchInputEl) {
    searchInputEl.value = '';
    searchQuery = '';
    searchInputEl.blur();
    renderClips();
  }
});

renderClips();
