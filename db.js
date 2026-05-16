const Database = require('better-sqlite3');
const db = new Database('./delivery.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    first_name TEXT, last_name TEXT, username TEXT,
    phone TEXT, role TEXT DEFAULT 'customer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_uz TEXT, name_ru TEXT, emoji TEXT DEFAULT '🍽',
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER, name_uz TEXT, name_ru TEXT,
    desc_uz TEXT DEFAULT '', desc_ru TEXT DEFAULT '',
    price INTEGER, image TEXT DEFAULT '', active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, user_name TEXT, user_phone TEXT,
    items TEXT, total INTEGER,
    address TEXT, lat REAL, lng REAL,
    comment TEXT DEFAULT '',
    payment TEXT DEFAULT 'cash',
    payment_status TEXT DEFAULT 'pending',
    status TEXT DEFAULT 'new',
    courier_id TEXT, courier_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

if (db.prepare('SELECT COUNT(*) as c FROM categories').get().c === 0) {
  const ac = db.prepare('INSERT INTO categories (name_uz,name_ru,emoji,sort_order) VALUES (?,?,?,?)');
  ac.run('Burgerlar','Бургеры','🍔',1);
  ac.run('Pizzalar','Пиццы','🍕',2);
  ac.run('Salatlar','Салаты','🥗',3);
  ac.run('Ichimliklar','Напитки','🥤',4);

  const ap = db.prepare('INSERT INTO products (category_id,name_uz,name_ru,desc_uz,desc_ru,price,image) VALUES (?,?,?,?,?,?,?)');
  ap.run(1,'Classic Burger','Классик Бургер',"Mol go'shti, salat, pomidor",'Говядина, салат, томат',35000,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80');
  ap.run(1,'Double Burger','Двойной Бургер',"Ikki qatlam go'sht, pishloq",'Двойная говядина, сыр',55000,'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=400&q=80');
  ap.run(1,'Chicken Burger','Чикен Бургер',"Tovuq go'shti, krem sous",'Курица, сливочный соус',40000,'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80');
  ap.run(2,'Margarita','Маргарита','Pomidor sousi, mozzarella','Томатный соус, моцарелла',55000,'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400&q=80');
  ap.run(2,'Pepperoni','Пепперони','Pepperoni, mozzarella','Пепперони, моцарелла',65000,'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=400&q=80');
  ap.run(2,'BBQ Chicken','ББК Чикен','Tovuq, BBQ sous','Курица, соус BBQ',70000,'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&q=80');
  ap.run(3,'Grek salat','Греческий салат','Pomidor, bodring, zaytun, feta','Томат, огурец, маслины, фета',30000,'https://images.unsplash.com/photo-1546793665-c74683f339c1?w=400&q=80');
  ap.run(3,'Sezar','Цезарь','Tovuq, krutony, romaine','Курица, гренки, ромэн',35000,'https://images.unsplash.com/photo-1550304943-4f24f54ddde9?w=400&q=80');
  ap.run(4,'Cola 0.5L','Кола 0.5Л','Sovuq','Холодная',10000,'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80');
  ap.run(4,'Limonad','Лимонад','Yangi siqilgan','Свежевыжатый',15000,'https://images.unsplash.com/photo-1621506289937-a8e4df240d0b?w=400&q=80');
  ap.run(4,'Ayron','Айран','Tabiiy, sovuq','Натуральный, холодный',8000,'https://images.unsplash.com/photo-1563227812-0ea4c22e6cc8?w=400&q=80');
}

module.exports = db;
