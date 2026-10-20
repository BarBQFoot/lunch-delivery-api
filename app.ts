import express from "express";
import cors from "cors";
import { router as order } from "./controller/order";
import { router as customer } from "./controller/customer";
import { router as jobSheets } from "./controller/job-sheet";

export const app = express();
app.use(cors());
// แปลงข้อมูลแบบข้อความทั่วไป (Text Body)
app.use(express.text());
// แปลงข้อมูลรูปแบบ JSON (JSON Body)
app.use(express.json());

app.use("/orders", order); 
app.use("/customers", customer);
app.use("/job-sheets", jobSheets);

app.use("/", (req, res) => {
  res.send("This is API server for practice project");
});
