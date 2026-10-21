export interface Order {
    order_id:      number;
    customer_id:   number;
    // เปลี่ยน: สำเนาจุดส่งตอนสร้างออเดอร์; null ได้ระหว่างเติมข้อมูลออเดอร์เก่า
    delivery_address: string | null;
    delivery_latitude: number | string | null;
    delivery_longitude: number | string | null;
    delivery_date: Date;
    quantity:      number;
    unit_price:    string;
    unit_cost:     string;
    is_simulated:  number;
    status:        Status;
}

export type Status = "ACTIVE";
