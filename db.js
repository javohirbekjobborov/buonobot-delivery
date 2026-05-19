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
    delivery_type TEXT DEFAULT 'delivery',
    status TEXT DEFAULT 'new',
    courier_id TEXT, courier_name TEXT,
    feedback_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, user_name TEXT, username TEXT,
    category TEXT,
    kassir INTEGER, taom INTEGER, tozalik INTEGER,
    comment TEXT DEFAULT '',
    photo_file_id TEXT DEFAULT '',
    shift TEXT,
    order_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec("ALTER TABLE orders ADD COLUMN feedback_sent INTEGER DEFAULT 0"); } catch(e) {}

try { db.exec("ALTER TABLE orders ADD COLUMN delivery_type TEXT DEFAULT 'delivery'"); } catch(e) {}

const oldDefault = ['Burgerlar','Pizzalar','Salatlar','Ichimliklar'];
const existingCats = db.prepare('SELECT name_uz FROM categories ORDER BY id').all().map(c=>c.name_uz);
if (existingCats.length === 4 && existingCats.every((n,i)=>n===oldDefault[i])) {
  db.exec('DELETE FROM products; DELETE FROM categories; DELETE FROM sqlite_sequence WHERE name IN ("products","categories");');
}

if (db.prepare('SELECT COUNT(*) as c FROM categories').get().c === 0) {
  const ac = db.prepare('INSERT INTO categories (name_uz,name_ru,emoji,sort_order) VALUES (?,?,?,?)');
  ac.run('Burger','Бургер','🍔',1);
  ac.run('Lavash-Xaggi','Лаваш-Хагги','🌯',2);
  ac.run('Hot-dog','Хот-дог','🌭',3);
  ac.run('Kombo-setlar','Комбо-сеты','🍱',4);
  ac.run('Sneklar','Снеки','🍟',5);
  ac.run('Ichimliklar','Напитки','🥤',6);

  const ap = db.prepare('INSERT INTO products (category_id,name_uz,name_ru,desc_uz,desc_ru,price,image) VALUES (?,?,?,?,?,?,?)');
  ap.run(1,'Classic Burger','Классик Бургер',"Mol go'shti, salat, pomidor",'Говядина, салат, томат',35000,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=80');
  ap.run(1,'Double Burger','Двойной Бургер',"Ikki qatlam go'sht, pishloq",'Двойная говядина, сыр',55000,'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=400&q=80');
  ap.run(1,'Chicken Burger','Чикен Бургер',"Tovuq go'shti, krem sous",'Курица, сливочный соус',40000,'https://images.unsplash.com/photo-1606755962773-d324e0a13086?w=400&q=80');
  ap.run(2,'Lavash','Лаваш',"Tovuq, sabzavotlar, sous",'Курица, овощи, соус',30000,'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=400&q=80');
  ap.run(2,'Xaggi','Хагги',"Mol go'shti, achchiq sous",'Говядина, острый соус',35000,'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=400&q=80');
  ap.run(3,'Klassik Hot-dog','Классический Хот-дог','Sosiska, sous, piyoz','Сосиска, соус, лук',20000,'https://images.unsplash.com/photo-1612392062798-2dc1c6c5e1cb?w=400&q=80');
  ap.run(3,'Cheese Hot-dog','Чиз Хот-дог','Sosiska, pishloq','Сосиска, сыр',25000,'https://images.unsplash.com/photo-1619740455993-9e612b1af08a?w=400&q=80');
  ap.run(4,'Burger Combo','Бургер Комбо','Burger + Fri + Cola','Бургер + Фри + Кола',55000,'https://images.unsplash.com/photo-1571091718767-18b5b1457add?w=400&q=80');
  ap.run(4,'Lavash Combo','Лаваш Комбо','Lavash + Fri + Cola','Лаваш + Фри + Кола',50000,'https://images.unsplash.com/photo-1639024471283-03518883512d?w=400&q=80');
  ap.run(5,'Fri kartoshka','Картошка фри','Tuzli, qovurilgan','Соленая, жареная',15000,'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80');
  ap.run(5,'Nuggets 6 ta','Наггетсы 6 шт','Tovuq nagets','Куриные наггетсы',20000,'https://images.unsplash.com/photo-1562967914-608f82629710?w=400&q=80');
  ap.run(6,'Cola 0.5L','Кола 0.5Л','Sovuq','Холодная',10000,'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80');
  ap.run(6,'Limonad','Лимонад','Yangi siqilgan','Свежевыжатый',15000,'https://images.unsplash.com/photo-1621506289937-a8e4df240d0b?w=400&q=80');
  ap.run(6,'Ayron','Айран','Tabiiy, sovuq','Натуральный, холодный',8000,'https://images.unsplash.com/photo-1563227812-0ea4c22e6cc8?w=400&q=80');
}

module.exports = db;
