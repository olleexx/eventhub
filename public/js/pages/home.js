import { boot, api, h, mount, eventCard, skeleton, empty, state, toastError, qs } from '/js/core.js';

const main = await boot({ active: 'home' });
const search = h('form', { class: 'searchbar', role: 'search', onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); location.href = `/events${qs({ q: f.get('q'), city: f.get('city') })}`; } },
  h('input', { class: 'input', name: 'q', type: 'search', placeholder: 'Search events, artists, venues', 'aria-label': 'Search events' }),
  h('input', { class: 'input', name: 'city', placeholder: 'City', 'aria-label': 'City' }),
  h('button', { class: 'btn coral', type: 'submit' }, 'Search'));
const content = h('div', null, skeleton(2, 220));
mount(main,
  h('section', { class: 'hero' }, h('div', { class: 'wrap' },
    h('h1', null, 'Find your next ', h('em', null, 'great night'), ' out.'),
    h('p', { class: 'lead' }, 'Discover events near you, or create your own for free. Organizers only pay a commission when tickets sell.'),
    search, h('div', { class: 'chips', id: 'cat-chips' }))),
  h('div', { class: 'wrap' }, content));

function row(title, list, more) {
  if (!list?.length) return null;
  return h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title), more && h('a', { href: more }, 'See all →')), h('div', { class: 'grid g4' }, list.map(eventCard)));
}
try {
  const d = await api.get('/api/home');
  const chips = document.getElementById('cat-chips');
  d.categories.filter((c) => c.count > 0).forEach((c) => chips.appendChild(h('a', { class: 'chip', href: `/events?category=${encodeURIComponent(c.slug)}` }, `${c.name} (${c.count})`)));
  const sections = [row('Featured', d.featured), row('Trending', d.trending, '/events?sort=popular'), row('Coming up', d.upcoming, '/events'), row('Selling fast', d.limited), row('Just added', d.newlyPublished, '/events?sort=new')].filter(Boolean);
  const cta = h('div', { class: 'cta-band' }, h('div', null, h('h2', null, 'Host an event?'), h('p', null, 'Free to create. We take a small commission only on tickets sold.')), h('a', { class: 'btn', href: state.user?.isOrganizer ? '/organizer#/events/new' : '/register?organizer=1' }, 'Create an event'));
  mount(content, ...(sections.length ? sections : [empty('No events yet', 'Be the first to publish one.', { href: '/register?organizer=1', label: 'Create an event' })]), cta);
} catch (e) { mount(content, empty('Could not load events', e.message)); toastError(e); }
