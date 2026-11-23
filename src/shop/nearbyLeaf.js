// #3824 (part of #3818, #3539): "Nearby", a leaf under Shop's own petal that lists the products within
// reach, nearest first, each a button that opens the same card a tap or the N key opens. It is for
// someone who cannot tap a product in the world and has no keyboard (a screen reader on a phone). It
// is not in the general menu (that one is the same in every mode) and nothing is drawn until it is
// opened, so it adds nothing standing on the world. The ordering is src/shop/nearbyProducts.js, the
// card and its focus are src/shop/productCard.js.
import { addBudPetals, openLeaf, closeLeaf } from '../ui/bud.js';
import { emptyState } from '../ui/emptyState.js';
import { nearbyProductChoices } from './productCard.js';
import { NEARBY_LEAF_EMPTY } from './nearbyProducts.js';

function openNearbyLeaf() {
  openLeaf({
    id: 'nearby',
    title: 'Nearby',
    render: (body) => {
      const choices = nearbyProductChoices();
      if (!choices.length) {
        body.append(emptyState(NEARBY_LEAF_EMPTY));
        return;
      }
      const list = document.createElement('ul');
      list.className = 'bud-nearby-list';
      for (const choice of choices) {
        const item = document.createElement('li');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'bud-nearby-row';
        const name = document.createElement('span');
        name.className = 'bud-nearby-name';
        name.textContent = choice.name;
        const distance = document.createElement('span');
        distance.className = 'bud-nearby-distance';
        // #4044: how far and which way ("9 m, ahead and to the left").
        distance.textContent = choice.direction ? `${choice.distance}, ${choice.direction}` : choice.distance;
        row.append(name, distance);
        row.addEventListener('click', () => {
          closeLeaf();
          choice.choose();
        });
        item.append(row);
        list.append(item);
      }
      body.append(list);
    },
  });
}

addBudPetals('shop', [{ id: 'nearby', label: 'Nearby', run: openNearbyLeaf }]);
