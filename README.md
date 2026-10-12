# PITLANE Garage — Workshop OS

Web app pengelolaan bengkel motor/mobil dengan tema dark racing. Versi ini menormalkan hubungan spare part dengan work order serta memindahkan kartu persediaan ke tabel transaksi tersendiri.

## Struktur folder

- `frontend/index.html` — dashboard, master customers/vehicles, work orders, inventory, invoices & AR, dan form/modal.
- `frontend/styles.css` — tampilan responsif.
- `frontend/frontend.js` — navigasi, validasi form, CRUD, dan rendering kartu persediaan.
- `backend/app.js` — Express REST API yang mengakses Supabase.
- `backend/supabase.sql` — schema dan migrasi database PostgreSQL/Supabase.

## ERD dan relasi

Database memiliki delapan entitas utama:

1. `customers` — pelanggan.
2. `vehicles` — kendaraan; FK `customer_id` → `customers.id`.
3. `parts` — master suku cadang dan saldo stok.
4. `work_orders` — pekerjaan bengkel; FK ke pelanggan dan kendaraan.
5. `work_order_parts` — tabel penghubung/detail pemakaian spare part; FK `work_order_id` → `work_orders.id` dan FK `part_id` → `parts.id`. Tabel ini menyimpan kuantitas, harga pokok/unit, harga jual/unit, subtotal biaya, dan subtotal penjualan.
6. `inventory_movements` — buku/kartu persediaan ternormalisasi. Setiap baris terkait dengan satu spare part dan menyimpan tanggal, jenis transaksi, referensi, jumlah masuk/keluar, saldo setelah transaksi, harga, catatan, dan opsional work order.
7. `invoices` — invoice piutang usaha; satu invoice untuk setiap work order, termasuk tanggal invoice, tanggal jatuh tempo, total, jumlah terbayar, dan status pembayaran.
8. `payments` — penerimaan pembayaran invoice; satu invoice dapat memiliki beberapa pembayaran.

Relasi utama:

- `customers` 1:N `vehicles`
- `customers` 1:N `work_orders`
- `vehicles` 1:N `work_orders`
- `work_orders` 1:N `work_order_parts`
- `parts` 1:N `work_order_parts`
- `parts` 1:N `inventory_movements`
- `work_orders` 1:N `inventory_movements` (opsional; pergerakan terkait pekerjaan)
- `work_orders` 1:1 `invoices`
- `invoices` 1:N `payments`

Dengan demikian, relasi konseptual `work_orders` M:N `parts` direalisasikan secara relasional lewat `work_order_parts`, bukan lagi hanya mengandalkan JSONB. Kolom lama `parts_used` dan `inventory_history` dipertahankan sementara agar data dari versi lama bisa dimigrasikan dengan aman; aplikasi versi baru menggunakan tabel relasional.

## Fitur

- Dashboard tanpa tombol demo data.
- CRUD master pelanggan dan master kendaraan secara terpisah; work order hanya memilih data master yang sudah terdaftar.
- CRUD work order dan perubahan status pekerjaan (Masuk, Dikerjakan, Menunggu Part, Selesai, Diambil).
- Pembuatan invoice otomatis untuk setiap work order, termasuk invoice template yang bisa dicetak atau disimpan sebagai PDF melalui dialog Print browser.
- Menu Accounts Receivable (AR): daftar invoice, total tagihan, pembayaran diterima, saldo piutang, dan status Belum Dibayar/Dibayar Sebagian/Lunas.
- Pencatatan pembayaran bertahap dengan metode Tunai, Transfer Bank, QRIS, Kartu Debit/Kredit, atau Lainnya; sistem menolak pembayaran melebihi sisa tagihan.
- CRUD master suku cadang.
- Transaksi pembelian, penjualan, dan penyesuaian stok.
- Kartu persediaan per item dengan saldo awal, pembelian, penjualan, pemakaian/pengembalian work order, tanggal, referensi, masuk/keluar, saldo, harga pokok, dan catatan.
- Work order menyimpan detail spare part di `work_order_parts` dan mengurangi stok saat spare part dipakai.
- Menghapus work order akan mencatat pergerakan pengembalian stok, bukan menghilangkan jejak pergerakan.
- Nilai biaya produksi/pekerjaan, pendapatan, dan laba kotor dihitung berdasarkan harga pokok dan harga jual yang tersimpan pada detail work order.
- Fungsi PostgreSQL `record_inventory_movement` mengunci baris stok untuk mencegah dua permintaan bersamaan menjual stok yang sama secara berlebih pada satu item.

## Menjalankan aplikasi

1. Buat atau buka project Supabase.
2. Buka **SQL Editor**, tempel seluruh isi `backend/supabase.sql`, lalu jalankan. Script ini membuat tabel baru dan memigrasikan data JSONB dari versi starter lama tanpa menjatuhkan tabel lama. Tetap lakukan backup sebelum migrasi database yang sudah berisi data penting.
3. Di terminal, masuk ke folder `backend`, lalu instal dependensi:

   ```bash
   npm install express cors @supabase/supabase-js
   ```

4. Atur environment variables. Jangan pernah menaruh service-role key di frontend.

   **Windows PowerShell**
   ```powershell
   $env:SUPABASE_URL="https://PROJECT_ID.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
   node app.js
   ```

   **macOS/Linux**
   ```bash
   export SUPABASE_URL="https://PROJECT_ID.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
   node app.js
   ```

5. Jalankan `frontend/index.html` menggunakan Live Server di VS Code. Backend harus tetap aktif di `http://localhost:3000`.
6. Jika frontend sudah terbuka, klik refresh atau muat ulang halaman agar data diambil kembali dari Supabase.

## Catatan keamanan dan konsistensi

- Gunakan `SUPABASE_SERVICE_ROLE_KEY` hanya di server. Jangan masukkan key tersebut ke `frontend.js` atau unggah ke GitHub.
- API starter ini belum dilengkapi autentikasi/otorisasi pengguna, sehingga jangan dipublikasikan untuk data operasional nyata sebelum menambahkan login, kontrol akses, validasi lebih ketat, rate limiting, dan logging.
- Pergerakan stok satu item dikunci dan dicatat melalui RPC PostgreSQL. Penerimaan pembayaran invoice juga memakai RPC transaksional yang mengunci invoice, memvalidasi saldo piutang, mencatat pembayaran, dan memperbarui status secara bersamaan. Namun, rangkaian multi-item pada satu work order masih dilakukan melalui beberapa permintaan backend, belum menjadi satu transaksi database menyeluruh; untuk sistem produksi, pindahkan pembuatan/edit/penghapusan work order beserta seluruh pergerakan stok ke satu fungsi RPC transaksional.
- Penghapusan item spare part ditolak jika sudah memiliki riwayat pergerakan atau dipakai dalam work order, demi menjaga jejak audit.
- `total_cost` mencakup harga pokok spare part, biaya tenaga kerja (`labor_hours × labor_rate`), dan overhead. `total_revenue` mencakup penjualan spare part dan biaya jasa. Sesuaikan kebijakan akuntansi dan penentuan biaya sesuai kebutuhan tugas/praktik.
