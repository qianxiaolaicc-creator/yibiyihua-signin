CREATE TRIGGER lesson_guard BEFORE INSERT ON lessons
BEGIN
 SELECT CASE WHEN NEW.active != 1 THEN RAISE(ABORT, 'INVALID_LESSON_STATE') END;
 SELECT CASE WHEN (SELECT balance FROM students WHERE id=NEW.student_id) < 1 THEN RAISE(ABORT, 'INSUFFICIENT_BALANCE') END;
END;
--> statement-breakpoint
CREATE TRIGGER lesson_deduct AFTER INSERT ON lessons
BEGIN
 UPDATE students SET balance=balance-1 WHERE id=NEW.student_id;
 INSERT INTO audit_log(id,student_id,action,description,created_at)
 VALUES('lesson:'||NEW.id,NEW.student_id,'lesson','记录 '||NEW.lesson_date||' 上课，扣除 1 课时，剩余 '||(SELECT balance FROM students WHERE id=NEW.student_id),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER lesson_undo_guard BEFORE UPDATE ON lessons
WHEN OLD.active=0 OR NEW.active!=0 OR NEW.student_id!=OLD.student_id OR NEW.lesson_date!=OLD.lesson_date
BEGIN
 SELECT RAISE(ABORT,'INVALID_LESSON_TRANSITION');
END;
--> statement-breakpoint
CREATE TRIGGER lesson_refund AFTER UPDATE OF active ON lessons
WHEN OLD.active=1 AND NEW.active=0
BEGIN
 UPDATE students SET balance=balance+1 WHERE id=NEW.student_id;
 INSERT INTO audit_log(id,student_id,action,description,created_at)
 VALUES('undo:'||NEW.id,NEW.student_id,'undo','撤销 '||NEW.lesson_date||' 上课，退回 1 课时，剩余 '||(SELECT balance FROM students WHERE id=NEW.student_id),NEW.voided_at);
END;
