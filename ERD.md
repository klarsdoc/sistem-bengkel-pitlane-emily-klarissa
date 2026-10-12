# ERD — PITLANE Garage (normalized)

```mermaid
erDiagram
  CUSTOMERS ||--o{ VEHICLES : owns
  CUSTOMERS ||--o{ WORK_ORDERS : requests
  VEHICLES ||--o{ WORK_ORDERS : serviced_in
  WORK_ORDERS ||--o{ WORK_ORDER_PARTS : contains
  PARTS ||--o{ WORK_ORDER_PARTS : used_as
  PARTS ||--o{ INVENTORY_MOVEMENTS : has_ledger
  WORK_ORDERS o|--o{ INVENTORY_MOVEMENTS : references
  WORK_ORDERS ||--|| INVOICES : billed_by
  INVOICES ||--o{ PAYMENTS : receives

  CUSTOMERS {
    uuid id PK
    text name
    text phone
    text email
    text address
  }
  VEHICLES {
    uuid id PK
    uuid customer_id FK
    text plate_number UK
    text make
    text model
    text vehicle_type
    int year
  }
  PARTS {
    uuid id PK
    text sku UK
    text name
    text category
    int stock
    int min_stock
    numeric unit_cost
    numeric selling_price
  }
  WORK_ORDERS {
    uuid id PK
    text job_number UK
    uuid customer_id FK
    uuid vehicle_id FK
    text complaint
    text status
    numeric labor_hours
    numeric labor_rate
    numeric overhead
    numeric service_charge
    numeric total_cost
    numeric total_revenue
    numeric gross_profit
  }
  WORK_ORDER_PARTS {
    uuid id PK
    uuid work_order_id FK
    uuid part_id FK
    int quantity
    numeric unit_cost
    numeric unit_price
  }
  INVOICES {
    uuid id PK
    text invoice_number UK
    uuid work_order_id FK_UK
    date invoice_date
    date due_date
    numeric total_amount
    numeric paid_amount
    text status
  }
  PAYMENTS {
    uuid id PK
    uuid invoice_id FK
    text payment_number UK
    date payment_date
    numeric amount
    text method
  }
  INVENTORY_MOVEMENTS {
    uuid id PK
    uuid part_id FK
    uuid work_order_id FK
    date movement_date
    text movement_type
    text reference
    int qty_in
    int qty_out
    int balance_after
    numeric unit_cost
    numeric unit_price
  }
```

## Cara membaca hubungan

- Satu pelanggan dapat memiliki beberapa kendaraan dan beberapa work order.
- Satu kendaraan dapat muncul di banyak work order sepanjang riwayat servisnya.
- Satu work order dapat menggunakan banyak jenis spare part.
- Satu jenis spare part dapat dipakai di banyak work order.
- Relasi many-to-many antara work order dan parts diwujudkan oleh `work_order_parts`.
- Setiap transaksi persediaan tercatat sebagai baris baru di `inventory_movements`, sehingga kartu persediaan tidak disimpan lagi hanya dalam satu kolom JSONB.


## Master data, work order, invoice, and payment flow

1. Tambahkan pelanggan melalui menu **Customers**.
2. Tambahkan kendaraan melalui menu **Vehicles** dan pilih pelanggan yang sudah ada.
3. Buat work order dengan memilih pelanggan dan kendaraan dari master data. Aplikasi tidak lagi membuat pelanggan/kendaraan otomatis dari form work order.
4. Setelah work order berhasil dibuat, sistem membuat satu invoice bernomor `INV-<nomor work order>` secara otomatis. SQL migrasi juga membuat invoice untuk work order lama yang belum memiliki invoice.
5. Menu **Invoices & AR** menampilkan total invoice, pembayaran yang diterima, sisa piutang, dan status pembayaran. Pembayaran bisa dicicil, tetapi tidak boleh melebihi saldo piutang.
6. Tombol **Print / PDF** membuka template invoice yang dapat dicetak atau disimpan sebagai PDF melalui opsi printer browser.

Status work order dan status pembayaran invoice adalah dua hal yang berbeda: work order menggambarkan progres servis, sedangkan invoice menggambarkan pelunasan tagihan.
