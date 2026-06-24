// Demo menu for testing. Lets developers exercise the conversation flow without
// running the camera capture or the paid OCR scan API. The data mirrors what
// parseMenuFromImages would return for a real multi-section menu, so every
// downstream feature (allergy filtering, recommendations, browsing, TTS) works
// exactly as it does in production — only the cost-incurring scan is skipped.

import { ParsedMenu } from '../types';

export const DEMO_RESTAURANT_NAME = 'The Copper Skillet';

export const DEMO_MENU: ParsedMenu = {
  restaurantName: DEMO_RESTAURANT_NAME,
  pageCount: 2,
  incomplete: false,
  notes: 'Demo menu for testing. No real restaurant. Prices in US dollars.',
  categories: [
    {
      name: 'Starters',
      items: [
        {
          name: 'Crispy Calamari',
          description: 'Lightly fried squid with lemon aioli and marinara.',
          price: '$13',
          ingredients: ['squid', 'wheat flour', 'egg', 'lemon', 'garlic'],
        },
        {
          name: 'Roasted Beet Bruschetta',
          description: 'Toasted sourdough, whipped goat cheese, roasted beets, honey.',
          price: '$11',
          ingredients: ['wheat bread', 'goat cheese', 'beets', 'honey', 'walnuts'],
        },
        {
          name: 'Spiced Chicken Wings',
          description: 'Dry-rubbed wings with a smoky chili glaze and ranch.',
          price: '$12',
          ingredients: ['chicken', 'chili', 'paprika', 'buttermilk', 'garlic'],
        },
        {
          name: 'Truffle Parmesan Fries',
          description: 'Hand-cut fries with parmesan, parsley, and truffle oil.',
          price: '$9.50',
          ingredients: ['potato', 'parmesan', 'parsley', 'truffle oil'],
        },
      ],
    },
    {
      name: 'Soups & Salads',
      items: [
        {
          name: 'Tomato Basil Soup',
          description: 'Slow-simmered tomatoes, fresh basil, a touch of cream.',
          price: '$8',
          ingredients: ['tomato', 'basil', 'cream', 'onion'],
        },
        {
          name: 'Caesar Salad',
          description: 'Romaine, shaved parmesan, garlic croutons, classic dressing.',
          price: '$10',
          ingredients: ['romaine', 'parmesan', 'wheat croutons', 'anchovy', 'egg'],
        },
        {
          name: 'Harvest Grain Bowl',
          description: 'Farro, roasted squash, kale, dried cranberries, tahini.',
          price: '$14',
          ingredients: ['farro', 'squash', 'kale', 'cranberries', 'sesame tahini'],
        },
      ],
    },
    {
      name: 'Mains',
      items: [
        {
          name: 'Grilled Salmon',
          description: 'Atlantic salmon, herb butter, roasted potatoes, asparagus.',
          price: '$26',
          ingredients: ['salmon', 'butter', 'potato', 'asparagus', 'dill'],
        },
        {
          name: 'Copper Skillet Burger',
          description: 'Aged cheddar, caramelized onion, house sauce, brioche bun.',
          price: '$18',
          ingredients: ['beef', 'cheddar', 'wheat bun', 'onion', 'egg'],
        },
        {
          name: 'Wild Mushroom Risotto',
          description: 'Arborio rice, mixed mushrooms, parmesan, white wine.',
          price: '$21',
          ingredients: ['rice', 'mushrooms', 'parmesan', 'white wine', 'butter'],
        },
        {
          name: 'Buttermilk Fried Chicken',
          description: 'Crispy thigh and breast, mashed potatoes, country gravy.',
          price: '$22',
          ingredients: ['chicken', 'buttermilk', 'wheat flour', 'potato'],
        },
      ],
    },
    {
      name: 'Pasta',
      items: [
        {
          name: 'Spaghetti Pomodoro',
          description: 'Fresh tomato sauce, garlic, basil, extra virgin olive oil.',
          price: '$16',
          ingredients: ['wheat pasta', 'tomato', 'garlic', 'basil', 'olive oil'],
        },
        {
          name: 'Shrimp Scampi Linguine',
          description: 'Garlic butter, white wine, lemon, parsley, chili flake.',
          price: '$23',
          ingredients: ['wheat pasta', 'shrimp', 'butter', 'garlic', 'white wine'],
        },
      ],
    },
    {
      name: 'Desserts',
      items: [
        {
          name: 'Molten Chocolate Cake',
          description: 'Warm chocolate cake, vanilla bean ice cream.',
          price: '$9',
          ingredients: ['chocolate', 'wheat flour', 'egg', 'butter', 'milk'],
        },
        {
          name: 'Seasonal Fruit Sorbet',
          description: 'Three scoops of dairy-free sorbet. Ask your server for flavors.',
          price: '$7',
          ingredients: ['fruit', 'sugar'],
        },
      ],
    },
    {
      name: 'Drinks',
      items: [
        {
          name: 'House Lemonade',
          description: 'Fresh-squeezed, lightly sweetened.',
          price: '$5',
          ingredients: ['lemon', 'sugar', 'water'],
        },
        {
          name: 'Cold Brew Coffee',
          description: 'Slow-steeped, served over ice.',
          price: '$5',
          ingredients: ['coffee'],
        },
        {
          name: 'Sparkling Limeade',
          description: 'Fresh lime, soda water, and simple syrup over ice.',
          price: '$4.75',
          ingredients: ['lime', 'soda water', 'sugar'],
        },
      ],
    },
  ],
};
